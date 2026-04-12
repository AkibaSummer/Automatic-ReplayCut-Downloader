package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/api"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/bilibili"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/config"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/db"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/downloader"
	"go.uber.org/zap"
)

type Worker struct {
	cfg            *config.Config
	logger         *zap.Logger
	biliClient     *bilibili.Client
	downloadEngine *downloader.Engine

	activeTasks   map[string]bool
	activeTasksMu sync.Mutex

	limiter  *taskLimiter
	cancelMu sync.Mutex
	cancels  map[string]context.CancelFunc

	pausedMu      sync.Mutex
	pausedReplays map[string]bool
}

func NewWorker(cfg *config.Config, logger *zap.Logger) *Worker {
	biliClient := bilibili.NewClient(cfg.Bilibili.AnchorID, cfg.Bilibili.Cookies, cfg.Bilibili.CookieFile)
	downloadEngine := downloader.NewEngine(cfg.Download.OutputDir, cfg.Download.TempDir, cfg.Download.FilenameTemplate, api.ProgressCh)
	downloadEngine.ConcurrentSegments = cfg.Download.ConcurrentSegments

	return &Worker{
		cfg:            cfg,
		logger:         logger,
		biliClient:     biliClient,
		downloadEngine: downloadEngine,
		activeTasks:    make(map[string]bool),
		limiter:        newTaskLimiter(cfg.Download.MaxConcurrentTasks),
		cancels:        make(map[string]context.CancelFunc),
		pausedReplays:  make(map[string]bool),
	}
}

func (w *Worker) Start() {
	// 1. Recover stuck tasks in background with a small delay
	// to ensure web server and websocket broadcaster are ready
	go func() {
		time.Sleep(2 * time.Second)
		w.Recover()
	}()

	// 2. Start periodic scan
	ticker := time.NewTicker(30 * time.Minute)
	go func() {
		for {
			w.Run()
			<-ticker.C
		}
	}()

	// 3. Periodically cleanup stale "downloading" states (dirty data)
	go func() {
		time.Sleep(30 * time.Second)
		w.CleanupStaleDownloadingNow()
		staleTicker := time.NewTicker(10 * time.Minute)
		for range staleTicker.C {
			w.CleanupStaleDownloadingNow()
		}
	}()
}

func (w *Worker) Recover() {
	replays, err := db.GetReplays()
	if err != nil {
		w.logger.Error("Failed to fetch replays for recovery", zap.Error(err))
		return
	}

	w.logger.Info("Checking for tasks to recover")
	count := 0
	for i := range replays {
		if replays[i].Status == "downloading" {
			w.logger.Info("Recovering interrupted task",
				zap.String("live_key", replays[i].LiveKey),
				zap.String("title", replays[i].Title))
			go w.processReplay(&replays[i])
			count++
		}
	}
	if count > 0 {
		w.logger.Info("Started recovery for interrupted tasks", zap.Int("count", count))
	} else {
		w.logger.Info("No tasks found to recover")
	}
}

func (w *Worker) Run() (api.ScanSummary, error) {
	sum := api.ScanSummary{}
	if !w.biliClient.IsLoggedIn() {
		w.logger.Warn("Bilibili not logged in, skipping scan")
		return sum, fmt.Errorf("Bilibili not logged in")
	}

	w.logger.Info("Starting Bilibili replay scan")
	replays, err := w.biliClient.GetReplayList(30, 1, 20)
	if err != nil {
		w.logger.Error("Failed to fetch replays", zap.Error(err))
		return sum, err
	}
	sum.Fetched = len(replays)

	for _, r := range replays {
		// Check DB
		existing, _ := db.GetReplayByLiveKey(r.LiveKey)

		if existing == nil {
			// New item, save to DB as pending
			existing = &r
			existing.Status = "pending"
			existing.Message = "Found new replay"

			// Download cover
			if r.CoverURL != "" {
				localCover, err := w.downloadEngine.DownloadCover(r.CoverURL, r.LiveKey)
				if err == nil {
					existing.LocalCover = localCover
					sum.CoversUpdated++
				}
			}

			db.SaveReplay(existing)
			w.logger.Info("Added new replay to DB", zap.String("live_key", r.LiveKey), zap.String("title", r.Title))
			sum.NewRecords++
			continue
		}

		updated := false
		coverUpdated := false
		if r.Title != "" && existing.Title != r.Title {
			existing.Title = r.Title
			updated = true
		}
		if r.CoverURL != "" && existing.CoverURL != r.CoverURL {
			existing.CoverURL = r.CoverURL
			updated = true
		}
		if r.StartTime != 0 && existing.StartTime != r.StartTime {
			existing.StartTime = r.StartTime
			updated = true
		}
		if r.EndTime != 0 && existing.EndTime != r.EndTime {
			existing.EndTime = r.EndTime
			updated = true
		}
		if r.Duration != 0 && existing.Duration != r.Duration {
			existing.Duration = r.Duration
			updated = true
		}
		if existing.LocalCover == "" && existing.CoverURL != "" {
			if localCover, err := w.downloadEngine.DownloadCover(existing.CoverURL, existing.LiveKey); err == nil {
				existing.LocalCover = localCover
				updated = true
				coverUpdated = true
			}
		}
		if existing.LocalCover != "" {
			coverPath := filepath.Join(w.cfg.Download.OutputDir, "covers", existing.LocalCover)
			if _, err := os.Stat(coverPath); err != nil && existing.CoverURL != "" {
				if localCover, err := w.downloadEngine.DownloadCover(existing.CoverURL, existing.LiveKey); err == nil {
					existing.LocalCover = localCover
					updated = true
					coverUpdated = true
				}
			}
		}

		markedDeleted := false
		if existing.Status == "completed" {
			resolved := resolveReplayFilePath(w.cfg.Download.OutputDir, existing.LiveKey, existing.FilePath)
			if resolved != "" && existing.FilePath != resolved {
				existing.FilePath = resolved
				updated = true
			}
			if resolved == "" {
				existing.Status = "deleted"
				existing.VerifyOk = false
				existing.Message = "Downloaded before but file path is unknown or missing. You can re-download."
				updated = true
				markedDeleted = true
			} else if _, err := os.Stat(resolved); err != nil {
				if found := findReplayFileByLiveKey(w.cfg.Download.OutputDir, existing.LiveKey); found != "" {
					existing.FilePath = found
					updated = true
				} else {
					existing.Status = "deleted"
					existing.VerifyOk = false
					existing.Message = "Downloaded before but file was deleted locally. You can re-download."
					updated = true
					markedDeleted = true
				}
			}
		}
		if updated {
			db.SaveReplay(existing)
			if markedDeleted {
				sum.MarkedDeleted++
			} else {
				sum.UpdatedRecords++
			}
			if coverUpdated {
				sum.CoversUpdated++
			}
		} else {
			sum.AlreadyUpToDate++
		}
	}
	return sum, nil
}

func resolveReplayFilePath(outputDir string, liveKey string, filePath string) string {
	fp := strings.TrimSpace(filePath)
	if fp == "" {
		return findReplayFileByLiveKey(outputDir, liveKey)
	}
	if filepath.IsAbs(fp) {
		return fp
	}
	if strings.TrimSpace(outputDir) == "" {
		return fp
	}
	return filepath.Join(outputDir, fp)
}

func findReplayFileByLiveKey(outputDir string, liveKey string) string {
	if strings.TrimSpace(outputDir) == "" || strings.TrimSpace(liveKey) == "" {
		return ""
	}
	patterns := []string{
		filepath.Join(outputDir, "*"+liveKey+"*.mp4"),
		filepath.Join(outputDir, "*"+liveKey+"*.mkv"),
		filepath.Join(outputDir, "*"+liveKey+"*.flv"),
	}
	for _, pat := range patterns {
		matches, _ := filepath.Glob(pat)
		if len(matches) > 0 {
			return matches[0]
		}
	}
	return ""
}

func (w *Worker) DownloadReplay(liveKey string) {
	replay, err := db.GetReplayByLiveKey(liveKey)
	if err != nil {
		w.logger.Error("Replay not found in DB", zap.String("live_key", liveKey))
		return
	}
	w.processReplay(replay)
}

func (w *Worker) PauseReplay(liveKey string) (bool, error) {
	w.pausedMu.Lock()
	w.pausedReplays[liveKey] = true
	w.pausedMu.Unlock()

	replay, err := db.GetReplayByLiveKey(liveKey)
	if err != nil || replay == nil {
		return false, err
	}
	replay.Status = "paused"
	replay.Message = "Paused"
	db.SaveReplay(replay)
	api.ProgressCh <- api.ProgressUpdate{
		LiveKey:  replay.LiveKey,
		Progress: replay.Progress,
		Status:   "paused",
		Message:  replay.Message,
	}

	w.cancelMu.Lock()
	cancel, ok := w.cancels[liveKey]
	if ok {
		cancel()
		delete(w.cancels, liveKey)
	}
	w.cancelMu.Unlock()
	return ok, nil
}

func (w *Worker) ResumeReplay(liveKey string) error {
	w.pausedMu.Lock()
	delete(w.pausedReplays, liveKey)
	w.pausedMu.Unlock()

	replay, err := db.GetReplayByLiveKey(liveKey)
	if err != nil || replay == nil {
		return err
	}
	if replay.Status == "paused" {
		replay.Status = "pending"
		replay.Message = "Resumed"
		db.SaveReplay(replay)
	}
	go w.processReplay(replay)
	return nil
}

func (w *Worker) CacheReplayM3U8(liveKey string) (*model.BilibiliReplay, error) {
	replay, err := db.GetReplayByLiveKey(liveKey)
	if err != nil || replay == nil {
		return nil, err
	}
	if !w.biliClient.IsLoggedIn() {
		return nil, fmt.Errorf("Bilibili not logged in")
	}
	streams, err := w.biliClient.GetReplayStreams(replay.LiveKey, replay.StartTime, replay.EndTime)
	if err != nil {
		return nil, err
	}
	streams = dedupeStreamsByM3U8URL(streams)

	client := &http.Client{Timeout: 15 * time.Second}
	var firstErr error
	for i := range streams {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, streams[i].Stream, nil)
		if err != nil {
			cancel()
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0")
		req.Header.Set("Referer", "https://www.bilibili.com/")
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		b, rerr := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		if rerr != nil {
			if firstErr == nil {
				firstErr = rerr
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			if firstErr == nil {
				firstErr = fmt.Errorf("bad status: %s", resp.Status)
			}
			continue
		}
		streams[i].M3U8Text = string(b)
	}

	if err := db.ReplaceReplayStreams(replay.ReplayID, streams); err != nil {
		return nil, err
	}
	replay.Streams = streams
	if err := db.SaveReplay(replay); err != nil {
		return nil, err
	}

	if firstErr != nil {
		w.logger.Warn("Cache m3u8 had partial failures", zap.String("live_key", liveKey), zap.Error(firstErr))
	}
	return replay, nil
}

func dedupeStreamsByM3U8URL(streams []model.StreamSlice) []model.StreamSlice {
	if len(streams) <= 1 {
		return streams
	}
	seenOrder := make([]string, 0, len(streams))
	last := make(map[string]model.StreamSlice, len(streams))
	for i := range streams {
		key := normalizeM3U8URL(streams[i].Stream)
		if _, ok := last[key]; !ok {
			seenOrder = append(seenOrder, key)
		}
		last[key] = streams[i]
	}
	out := make([]model.StreamSlice, 0, len(seenOrder))
	for _, key := range seenOrder {
		out = append(out, last[key])
	}
	return out
}

func normalizeM3U8URL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil {
		return s
	}
	q := u.Query()
	q.Del("ts")
	q.Del("sign")
	u.RawQuery = q.Encode()
	return u.String()
}

func (w *Worker) EnsureLoggedIn() error {
	if w.biliClient.IsLoggedIn() {
		return nil
	}
	w.logger.Warn("Bilibili not logged in, starting login flow...")
	return w.biliClient.LoginWithQRCode()
}

func (w *Worker) SyncAll() {
	replays, err := db.GetReplays()
	if err != nil {
		w.logger.Error("Failed to fetch replays from DB", zap.Error(err))
		return
	}

	w.logger.Info("Starting sync all pending tasks", zap.Int("total", len(replays)))
	for i := range replays {
		if replays[i].Status == "pending" || replays[i].Status == "failed" || replays[i].Status == "deleted" {
			w.logger.Info("Syncing task", zap.String("live_key", replays[i].LiveKey))
			w.processReplay(&replays[i])
		}
	}
	w.logger.Info("Sync all pending tasks finished")
}

func (w *Worker) processReplay(replay *model.BilibiliReplay) {
	w.activeTasksMu.Lock()
	if w.activeTasks[replay.LiveKey] {
		w.activeTasksMu.Unlock()
		w.logger.Info("Task already running, skipping", zap.String("live_key", replay.LiveKey))
		return
	}
	w.activeTasks[replay.LiveKey] = true
	w.activeTasksMu.Unlock()

	defer func() {
		if r := recover(); r != nil {
			w.logger.Error("Replay task panicked", zap.Any("panic", r), zap.String("live_key", replay.LiveKey))
			replay.Status = "failed"
			replay.Message = fmt.Sprintf("Task panicked: %v", r)
			db.SaveReplay(replay)
			api.ProgressCh <- api.ProgressUpdate{
				LiveKey:  replay.LiveKey,
				Progress: 0,
				Status:   "failed",
				Message:  replay.Message,
			}
		}
		w.cancelMu.Lock()
		if cancel, ok := w.cancels[replay.LiveKey]; ok {
			cancel()
			delete(w.cancels, replay.LiveKey)
		}
		w.cancelMu.Unlock()
		w.activeTasksMu.Lock()
		delete(w.activeTasks, replay.LiveKey)
		w.activeTasksMu.Unlock()
	}()

	w.logger.Info("Processing replay", zap.String("live_key", replay.LiveKey), zap.String("title", replay.Title))

	w.downloadEngine.OutputDir = w.cfg.Download.OutputDir
	w.downloadEngine.TempDir = w.cfg.Download.TempDir
	w.downloadEngine.FilenameTemplate = w.cfg.Download.FilenameTemplate
	w.downloadEngine.ConcurrentSegments = w.cfg.Download.ConcurrentSegments
	w.limiter.SetLimit(w.cfg.Download.MaxConcurrentTasks)

	w.pausedMu.Lock()
	paused := w.pausedReplays[replay.LiveKey]
	w.pausedMu.Unlock()
	if paused {
		replay.Status = "paused"
		replay.Message = "Paused"
		db.SaveReplay(replay)
		api.ProgressCh <- api.ProgressUpdate{
			LiveKey:  replay.LiveKey,
			Progress: replay.Progress,
			Status:   "paused",
			Message:  replay.Message,
		}
		return
	}

	if w.limiter.IsPaused() {
		replay.Status = "paused"
		replay.Message = "Paused"
		db.SaveReplay(replay)
		api.ProgressCh <- api.ProgressUpdate{
			LiveKey:  replay.LiveKey,
			Progress: replay.Progress,
			Status:   "paused",
			Message:  replay.Message,
		}
		return
	}

	replay.Status = "pending"
	replay.Message = "Waiting for available slot..."
	db.SaveReplay(replay)
	api.ProgressCh <- api.ProgressUpdate{
		LiveKey:  replay.LiveKey,
		Progress: replay.Progress,
		Status:   "pending",
		Message:  replay.Message,
	}
	if err := w.limiter.Acquire(context.Background()); err != nil {
		if errors.Is(err, ErrPaused) {
			replay.Status = "paused"
			replay.Message = "Paused"
			db.SaveReplay(replay)
			api.ProgressCh <- api.ProgressUpdate{
				LiveKey:  replay.LiveKey,
				Progress: replay.Progress,
				Status:   "paused",
				Message:  replay.Message,
			}
			return
		}
		replay.Status = "failed"
		replay.Message = err.Error()
		db.SaveReplay(replay)
		api.ProgressCh <- api.ProgressUpdate{
			LiveKey:  replay.LiveKey,
			Progress: 0,
			Status:   "failed",
			Message:  replay.Message,
		}
		return
	}
	defer w.limiter.Release()

	ctx, cancel := context.WithCancel(context.Background())
	w.cancelMu.Lock()
	w.cancels[replay.LiveKey] = cancel
	w.cancelMu.Unlock()

	replay.Status = "pending"
	replay.Message = "Fetching stream list..."
	db.SaveReplay(replay)
	api.ProgressCh <- api.ProgressUpdate{
		LiveKey:  replay.LiveKey,
		Progress: replay.Progress,
		Status:   "pending",
		Message:  replay.Message,
	}
	streams, err := w.biliClient.GetReplayStreams(replay.LiveKey, replay.StartTime, replay.EndTime)
	if err != nil {
		w.logger.Error("Failed to fetch streams", zap.String("live_key", replay.LiveKey), zap.Error(err))
		replay.Status = "failed"
		replay.Message = fmt.Sprintf("Fetch streams failed: %v", err)
		db.SaveReplay(replay)
		api.ProgressCh <- api.ProgressUpdate{
			LiveKey:  replay.LiveKey,
			Progress: 0,
			Status:   "failed",
			Message:  replay.Message,
		}
		return
	}
	replay.Streams = streams
	replay.Status = "downloading"
	replay.Message = "Starting download..."
	db.SaveReplay(replay)

	// Send initial progress update to UI
	api.ProgressCh <- api.ProgressUpdate{
		LiveKey:  replay.LiveKey,
		Progress: 0,
		Status:   "downloading",
		Message:  "Initializing download...",
	}

	filePath, err := w.downloadEngine.DownloadReplayWithContext(ctx, *replay)
	if err != nil {
		w.logger.Error("Download failed", zap.String("live_key", replay.LiveKey), zap.Error(err))
		progress := replay.Progress
		if cur, e := db.GetReplayByLiveKey(replay.LiveKey); e == nil && cur != nil {
			progress = cur.Progress
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, ErrPaused) {
			replay.Status = "paused"
			replay.Message = "Paused"
		} else {
			replay.Status = "failed"
			replay.Message = err.Error()
		}
		db.SaveReplay(replay)
		api.ProgressCh <- api.ProgressUpdate{
			LiveKey:  replay.LiveKey,
			Progress: progress,
			Status:   replay.Status,
			Message:  replay.Message,
		}
		return
	}

	replay.Message = "Verifying duration..."
	db.SaveReplay(replay)
	ok, dur, err := w.downloadEngine.VerifyDuration(filePath, replay.Duration)
	if err != nil {
		w.logger.Error("Verification failed", zap.String("live_key", replay.LiveKey), zap.Error(err))
		replay.Message = fmt.Sprintf("Verify failed: %v", err)
	}

	replay.FilePath = filePath
	replay.Status = "completed"
	replay.VerifyOk = ok
	replay.ActualDur = dur

	// Get extra file info
	info, err := w.downloadEngine.GetFileInfo(filePath)
	if err == nil {
		replay.FileSize = info.Size
		replay.Resolution = info.Resolution
		replay.Bitrate = info.Bitrate
	}

	if ok {
		replay.Message = "Success"
	} else {
		replay.Message = fmt.Sprintf("Duration mismatch: expected %d, got %.1f", replay.Duration, dur)
	}
	db.SaveReplay(replay)
}

func (w *Worker) CleanupStaleDownloadingNow() (int, error) {
	replays, err := db.GetReplays()
	if err != nil {
		w.logger.Error("Failed to fetch replays for stale cleanup", zap.Error(err))
		return 0, err
	}

	now := time.Now()
	updated := 0

	for i := range replays {
		if replays[i].Status != "downloading" {
			continue
		}

		w.activeTasksMu.Lock()
		active := w.activeTasks[replays[i].LiveKey]
		w.activeTasksMu.Unlock()
		if active {
			continue
		}

		if now.Sub(replays[i].UpdatedAt) <= 5*time.Minute {
			continue
		}

		replays[i].Status = "failed"
		replays[i].Message = "Stale downloading state reset (no active task)"
		db.SaveReplay(&replays[i])
		api.ProgressCh <- api.ProgressUpdate{
			LiveKey:  replays[i].LiveKey,
			Progress: 0,
			Status:   "failed",
			Message:  replays[i].Message,
		}
		updated++
	}

	if updated > 0 {
		w.logger.Info("Cleaned up stale downloading tasks", zap.Int("count", updated))
	}
	return updated, nil
}

func (w *Worker) GetMe() (api.Me, error) {
	if !w.biliClient.IsLoggedIn() {
		return api.Me{LoggedIn: false}, nil
	}
	u, err := w.biliClient.GetCurrentUser()
	if err != nil {
		return api.Me{LoggedIn: true}, err
	}
	return api.Me{LoggedIn: true, Uname: u.Uname, Face: u.Face}, nil
}

func (w *Worker) PauseAll() (int, error) {
	w.limiter.Pause()

	w.cancelMu.Lock()
	count := 0
	for liveKey, cancel := range w.cancels {
		cancel()
		delete(w.cancels, liveKey)
		count++
	}
	w.cancelMu.Unlock()

	return count, nil
}

func (w *Worker) ResumeAll() error {
	w.limiter.Resume()
	return nil
}

func (w *Worker) GetRuntime() api.Runtime {
	return api.Runtime{
		Paused:             w.limiter.IsPaused(),
		MaxConcurrentTasks: w.cfg.Download.MaxConcurrentTasks,
		ConcurrentSegments: w.cfg.Download.ConcurrentSegments,
	}
}
