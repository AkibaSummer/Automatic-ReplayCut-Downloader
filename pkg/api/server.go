package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/config"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/db"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type WorkerInterface interface {
	Run() (ScanSummary, error)
	SyncAll()
	DownloadReplay(liveKey string)
	PauseReplay(liveKey string) (bool, error)
	ResumeReplay(liveKey string) error
	CacheReplayM3U8(liveKey string) (*model.BilibiliReplay, error)
	GetMe() (Me, error)
	CleanupStaleDownloadingNow() (int, error)
	PauseAll() (int, error)
	ResumeAll() error
	GetRuntime() Runtime
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type ProgressUpdate struct {
	LiveKey       string    `json:"live_key"`
	Progress      float64   `json:"progress"`
	MergeProgress float64   `json:"merge_progress"`
	Status        string    `json:"status"`
	Message       string    `json:"message"`
	Speed         string    `json:"speed"`
	SpeedHistory  []float64 `json:"speed_history"`
	Elapsed       string    `json:"elapsed"`
	ETA           string    `json:"eta"`
}

type Me struct {
	LoggedIn bool   `json:"logged_in"`
	Uname    string `json:"uname"`
	Face     string `json:"face"`
}

type Runtime struct {
	Paused             bool `json:"paused"`
	MaxConcurrentTasks int  `json:"max_concurrent_tasks"`
	ConcurrentSegments int  `json:"concurrent_segments"`
}

type ScanSummary struct {
	Fetched         int `json:"fetched"`
	NewRecords      int `json:"new_records"`
	UpdatedRecords  int `json:"updated_records"`
	CoversUpdated   int `json:"covers_updated"`
	MarkedDeleted   int `json:"marked_deleted"`
	AlreadyUpToDate int `json:"already_up_to_date"`
}

type DiskStats struct {
	Path               string `json:"path"`
	TotalBytes         uint64 `json:"total_bytes"`
	FreeBytes          uint64 `json:"free_bytes"`
	UsedByServiceBytes uint64 `json:"used_by_service_bytes"`
}

var (
	clients        = make(map[*websocket.Conn]bool)
	clientsMu      sync.Mutex
	ProgressCh     = make(chan ProgressUpdate, 100)
	workerInstance WorkerInterface
	activeTasks    = make(map[string]ProgressUpdate)
	activeTasksMu  sync.Mutex
)

func SetWorker(w WorkerInterface) {
	workerInstance = w
}

func StartServer(cfg *config.Config) error {
	r := gin.Default()
	r.Use(gin.Recovery())

	// Serve covers
	r.GET("/covers/*filepath", func(c *gin.Context) {
		rel := strings.TrimPrefix(c.Param("filepath"), "/")
		if rel == "" || strings.Contains(rel, "..") {
			c.Status(http.StatusNotFound)
			return
		}
		full := filepath.Join(cfg.Download.OutputDir, "covers", rel)
		if _, err := os.Stat(full); err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.File(full)
	})

	// API routes
	apiGroup := r.Group("/api")
	{
		apiGroup.GET("/health", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		})
		apiGroup.GET("/version", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{
				"version":    BuildVersion,
				"commit":     BuildCommit,
				"build_time": BuildTime,
			})
		})
		apiGroup.GET("/runtime", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusOK, Runtime{})
				return
			}
			c.JSON(http.StatusOK, workerInstance.GetRuntime())
		})
		apiGroup.GET("/stats/disk", func(c *gin.Context) {
			if cfg == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Config not loaded"})
				return
			}
			out := strings.TrimSpace(cfg.Download.OutputDir)
			if out == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "output_dir is empty"})
				return
			}
			stats, err := getDiskStats(out, strings.TrimSpace(cfg.Download.TempDir))
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, stats)
		})
		apiGroup.GET("/fs/list", func(c *gin.Context) {
			cur := c.Query("path")
			if cur == "" {
				if runtime.GOOS == "windows" {
					type entry struct {
						Name string `json:"name"`
						Path string `json:"path"`
					}
					var entries []entry
					for ch := byte('A'); ch <= byte('Z'); ch++ {
						p := string(ch) + ":\\"
						if _, err := os.Stat(p); err == nil {
							entries = append(entries, entry{Name: p, Path: p})
						}
					}
					c.JSON(http.StatusOK, gin.H{"current": "", "parent": "", "entries": entries})
					return
				}
				cur = string(filepath.Separator)
			}
			info, err := os.Stat(cur)
			if err != nil || !info.IsDir() {
				c.JSON(http.StatusBadRequest, gin.H{"error": "path is not a directory"})
				return
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				parent = ""
			}
			type entry struct {
				Name string `json:"name"`
				Path string `json:"path"`
			}
			var entries []entry
			items, err := os.ReadDir(cur)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			for _, it := range items {
				if !it.IsDir() {
					continue
				}
				name := it.Name()
				entries = append(entries, entry{Name: name, Path: filepath.Join(cur, name)})
			}
			c.JSON(http.StatusOK, gin.H{"current": cur, "parent": parent, "entries": entries})
		})
		apiGroup.GET("/config", func(c *gin.Context) {
			if cfg == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Config not loaded"})
				return
			}
			c.JSON(http.StatusOK, cfg)
		})
		apiGroup.GET("/me", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusOK, Me{LoggedIn: false})
				return
			}
			me, err := workerInstance.GetMe()
			if err != nil {
				c.JSON(http.StatusOK, me)
				return
			}
			c.JSON(http.StatusOK, me)
		})
		apiGroup.GET("/avatar", func(c *gin.Context) {
			raw := c.Query("url")
			if raw == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "missing url"})
				return
			}
			u, err := url.Parse(raw)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "bad url"})
				return
			}
			host := strings.ToLower(u.Host)
			if !(strings.HasSuffix(host, ".hdslb.com") || host == "hdslb.com") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "host not allowed"})
				return
			}
			if u.Scheme != "https" && u.Scheme != "http" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "scheme not allowed"})
				return
			}

			req, err := http.NewRequest(http.MethodGet, u.String(), nil)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			req.Header.Set("User-Agent", "Mozilla/5.0")
			req.Header.Set("Referer", "https://www.bilibili.com/")
			client := &http.Client{Timeout: 10 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				c.JSON(http.StatusBadGateway, gin.H{"error": resp.Status})
				return
			}
			contentType := resp.Header.Get("Content-Type")
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			c.Status(http.StatusOK)
			c.Header("Content-Type", contentType)
			io.Copy(c.Writer, resp.Body)
		})
		apiGroup.POST("/config", func(c *gin.Context) {
			renameExisting := false
			switch strings.ToLower(strings.TrimSpace(c.Query("rename_existing"))) {
			case "1", "true", "yes", "y":
				renameExisting = true
			}

			var newCfg config.Config
			if err := c.ShouldBindJSON(&newCfg); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
			oldCfg := *cfg
			oldOutputDir := oldCfg.Download.OutputDir
			if newCfg.Bilibili.Cookies == nil {
				newCfg.Bilibili.Cookies = oldCfg.Bilibili.Cookies
			}
			if newCfg.Bilibili.CookieFile == "" {
				newCfg.Bilibili.CookieFile = oldCfg.Bilibili.CookieFile
			}
			if newCfg.Download.TempDir == "" {
				newCfg.Download.TempDir = oldCfg.Download.TempDir
			}
			if newCfg.Download.FilenameTemplate == "" {
				newCfg.Download.FilenameTemplate = oldCfg.Download.FilenameTemplate
			}
			if newCfg.Download.MaxConcurrentTasks == 0 {
				newCfg.Download.MaxConcurrentTasks = oldCfg.Download.MaxConcurrentTasks
			}
			if newCfg.Download.ConcurrentSegments == 0 {
				newCfg.Download.ConcurrentSegments = oldCfg.Download.ConcurrentSegments
			}
			migrated := 0
			if oldOutputDir != "" && newCfg.Download.OutputDir != "" && filepath.Clean(oldOutputDir) != filepath.Clean(newCfg.Download.OutputDir) {
				if err := os.MkdirAll(newCfg.Download.OutputDir, 0755); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				if err := os.MkdirAll(filepath.Join(newCfg.Download.OutputDir, "covers"), 0755); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}

				cnt, err := migrateOutputDir(oldOutputDir, newCfg.Download.OutputDir)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				migrated = cnt
			}

			renamed := 0
			if renameExisting && strings.TrimSpace(oldCfg.Download.FilenameTemplate) != strings.TrimSpace(newCfg.Download.FilenameTemplate) {
				cnt, err := renameExistingDownloadedFiles(newCfg.Download.OutputDir, newCfg.Download.FilenameTemplate)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				renamed = cnt
			}
			*cfg = newCfg
			if err := cfg.Save(); err != nil {
				*cfg = oldCfg
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.Header("X-Migrated-Files", fmt.Sprintf("%d", migrated))
			c.Header("X-Renamed-Files", fmt.Sprintf("%d", renamed))
			c.JSON(http.StatusOK, cfg)
		})
		apiGroup.GET("/replays", func(c *gin.Context) {
			replays, err := db.GetReplays()
			if err != nil {
				fmt.Printf("Error fetching replays: %v\n", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			outputDir := ""
			if cfg != nil {
				outputDir = cfg.Download.OutputDir
			}
			for i := range replays {
				if replays[i].Status != "completed" {
					continue
				}
				resolved, ok := resolveReplayFilePath(outputDir, replays[i].LiveKey, replays[i].FilePath)
				if ok && resolved != "" && replays[i].FilePath != resolved {
					replays[i].FilePath = resolved
					_ = db.SaveReplay(&replays[i])
				}
				if resolved == "" {
					replays[i].Status = "deleted"
					replays[i].VerifyOk = false
					replays[i].Message = "Downloaded before but file path is unknown or missing. You can re-download."
					_ = db.SaveReplay(&replays[i])
					continue
				}
				if _, err := os.Stat(resolved); err != nil {
					if found, ok := findReplayFileByLiveKey(outputDir, replays[i].LiveKey); ok && found != "" {
						replays[i].FilePath = found
						_ = db.SaveReplay(&replays[i])
						continue
					}
					replays[i].Status = "deleted"
					replays[i].VerifyOk = false
					replays[i].Message = "Downloaded before but file was deleted locally. You can re-download."
					_ = db.SaveReplay(&replays[i])
				}
			}
			c.JSON(http.StatusOK, replays)
		})
		apiGroup.POST("/scan", func(c *gin.Context) {
			if workerInstance != nil {
				sum, err := workerInstance.Run()
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				c.JSON(http.StatusOK, sum)
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
			}
		})
		apiGroup.POST("/sync-all", func(c *gin.Context) {
			if workerInstance != nil {
				go workerInstance.SyncAll()
				c.JSON(http.StatusOK, gin.H{"message": "Sync started"})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
			}
		})
		apiGroup.POST("/cleanup-stale", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
				return
			}
			count, err := workerInstance.CleanupStaleDownloadingNow()
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"message": "Cleanup finished", "count": count})
		})
		apiGroup.POST("/pause-all", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
				return
			}
			count, err := workerInstance.PauseAll()
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"message": "Paused", "count": count})
		})
		apiGroup.POST("/resume-all", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
				return
			}
			if err := workerInstance.ResumeAll(); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"message": "Resumed"})
		})
		apiGroup.POST("/replays/:live_key/download", func(c *gin.Context) {
			liveKey := c.Param("live_key")
			if workerInstance != nil {
				go workerInstance.DownloadReplay(liveKey)
				c.JSON(http.StatusOK, gin.H{"message": "Download started"})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
			}
		})
		apiGroup.POST("/replays/:live_key/pause", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
				return
			}
			liveKey := c.Param("live_key")
			paused, err := workerInstance.PauseReplay(liveKey)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"message": "Paused", "paused": paused})
		})
		apiGroup.POST("/replays/:live_key/resume", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
				return
			}
			liveKey := c.Param("live_key")
			if err := workerInstance.ResumeReplay(liveKey); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, gin.H{"message": "Resumed"})
		})
		apiGroup.POST("/replays/:live_key/delete-file", func(c *gin.Context) {
			if cfg == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Config not loaded"})
				return
			}
			liveKey := c.Param("live_key")
			replay, err := db.GetReplayByLiveKey(liveKey)
			if err != nil || replay == nil {
				c.JSON(http.StatusNotFound, gin.H{"error": "replay not found"})
				return
			}
			resolved, _ := resolveReplayFilePath(cfg.Download.OutputDir, replay.LiveKey, replay.FilePath)
			if resolved == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "file_path is empty"})
				return
			}
			ok, err := isSubpath(cfg.Download.OutputDir, resolved)
			if err != nil || !ok {
				c.JSON(http.StatusBadRequest, gin.H{"error": "file_path is not under output_dir"})
				return
			}
			if err := os.Remove(resolved); err != nil && !os.IsNotExist(err) {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			replay.FilePath = resolved
			replay.Status = "deleted"
			replay.VerifyOk = false
			replay.Message = "File deleted by user."
			_ = db.SaveReplay(replay)
			c.JSON(http.StatusOK, replay)
		})
		apiGroup.POST("/replays/:live_key/cache-m3u8", func(c *gin.Context) {
			if workerInstance == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
				return
			}
			liveKey := c.Param("live_key")
			replay, err := workerInstance.CacheReplayM3U8(liveKey)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, replay)
		})
	}

	// WebSocket for progress
	r.GET("/ws", func(c *gin.Context) {
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		clientsMu.Lock()
		clients[conn] = true
		clientsMu.Unlock()

		// Send current active tasks to the new client
		activeTasksMu.Lock()
		for liveKey, update := range activeTasks {
			replay, err := db.GetReplayByLiveKey(liveKey)
			if err != nil || replay == nil || (replay.Status != "downloading" && replay.Status != "merging" && replay.Status != "paused") {
				delete(activeTasks, liveKey)
				continue
			}
			data, _ := json.Marshal(update)
			conn.WriteMessage(websocket.TextMessage, data)
		}
		activeTasksMu.Unlock()

		defer func() {
			clientsMu.Lock()
			delete(clients, conn)
			clientsMu.Unlock()
		}()

		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				break
			}
		}
	})

	// Broadcast progress
	go func() {
		lastPersistAt := make(map[string]time.Time)
		lastPersistProgress := make(map[string]float64)
		for update := range ProgressCh {
			// Update active tasks map
			activeTasksMu.Lock()
			if update.Status == "completed" || update.Status == "failed" {
				delete(activeTasks, update.LiveKey)
			} else {
				activeTasks[update.LiveKey] = update
			}
			activeTasksMu.Unlock()

			shouldPersist := false
			now := time.Now()
			if update.Status == "completed" || update.Status == "failed" || update.Status == "paused" || update.Status == "merging" {
				shouldPersist = true
			}
			if !shouldPersist {
				if lp, ok := lastPersistAt[update.LiveKey]; !ok || now.Sub(lp) >= 2*time.Second {
					shouldPersist = true
				}
			}
			if shouldPersist {
				prevProg := lastPersistProgress[update.LiveKey]
				if prevProg == 0 {
					prevProg = update.Progress
				}
				newProg := update.Progress
				if newProg < prevProg && (update.Status == "downloading" || update.Status == "merging" || update.Status == "paused") {
					newProg = prevProg
				}
				updates := map[string]interface{}{
					"progress": newProg,
					"status":   update.Status,
					"message":  update.Message,
				}
				if update.Speed != "" {
					updates["speed"] = update.Speed
				}
				if update.Elapsed != "" {
					updates["elapsed"] = update.Elapsed
				}
				if update.ETA != "" {
					updates["eta"] = update.ETA
				}
				_ = db.DB.Model(&model.BilibiliReplay{}).Where("live_key = ?", update.LiveKey).Updates(updates).Error
				lastPersistAt[update.LiveKey] = now
				lastPersistProgress[update.LiveKey] = newProg
			}

			data, _ := json.Marshal(update)
			clientsMu.Lock()
			for client := range clients {
				client.WriteMessage(websocket.TextMessage, data)
			}
			clientsMu.Unlock()
		}
	}()

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	return r.Run(addr)
}

func migrateOutputDir(oldDir string, newDir string) (int, error) {
	oldDir = filepath.Clean(oldDir)
	newDir = filepath.Clean(newDir)
	if oldDir == "" || newDir == "" || oldDir == newDir {
		return 0, nil
	}
	if err := os.MkdirAll(newDir, 0755); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Join(newDir, "covers"), 0755); err != nil {
		return 0, err
	}

	replays, err := db.GetReplays()
	if err != nil {
		return 0, err
	}

	moved := 0
	for i := range replays {
		changed := false

		if replays[i].FilePath != "" {
			src := replays[i].FilePath
			dst := filepath.Join(newDir, filepath.Base(src))
			if _, err := os.Stat(dst); err == nil {
				if replays[i].FilePath != dst {
					replays[i].FilePath = dst
					changed = true
				}
			} else if _, err := os.Stat(src); err == nil {
				if err := moveFile(src, dst); err != nil {
					return moved, err
				}
				replays[i].FilePath = dst
				changed = true
				moved++
			}
		}

		if replays[i].LocalCover != "" {
			srcCover := filepath.Join(oldDir, "covers", replays[i].LocalCover)
			dstCover := filepath.Join(newDir, "covers", replays[i].LocalCover)
			if _, err := os.Stat(dstCover); err == nil {
			} else if _, err := os.Stat(srcCover); err == nil {
				if err := moveFile(srcCover, dstCover); err != nil {
					return moved, err
				}
				moved++
			}
		}

		if changed {
			db.SaveReplay(&replays[i])
		}
	}

	return moved, nil
}

func moveFile(src string, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(dst)
		return closeErr
	}
	return os.Remove(src)
}

var (
	filenameStartLayoutRe = regexp.MustCompile(`\{start:([^}]+)\}`)
	filenameEndLayoutRe   = regexp.MustCompile(`\{end:([^}]+)\}`)
)

func sanitizeFilename(name string) string {
	badChars := []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|"}
	for _, char := range badChars {
		name = strings.ReplaceAll(name, char, "_")
	}
	return name
}

func renderFilenameTemplate(tpl string, replay model.BilibiliReplay) string {
	start := time.Unix(replay.StartTime, 0)
	end := time.Unix(replay.EndTime, 0)

	out := tpl
	out = filenameStartLayoutRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := filenameStartLayoutRe.FindStringSubmatch(m)
		if len(sub) != 2 {
			return m
		}
		return start.Format(sub[1])
	})
	out = filenameEndLayoutRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := filenameEndLayoutRe.FindStringSubmatch(m)
		if len(sub) != 2 {
			return m
		}
		return end.Format(sub[1])
	})

	out = strings.ReplaceAll(out, "{title}", replay.Title)
	out = strings.ReplaceAll(out, "{live_key}", replay.LiveKey)
	out = strings.ReplaceAll(out, "{yyyy}", fmt.Sprintf("%04d", start.Year()))
	out = strings.ReplaceAll(out, "{yy}", start.Format("06"))
	out = strings.ReplaceAll(out, "{MM}", start.Format("01"))
	out = strings.ReplaceAll(out, "{dd}", start.Format("02"))
	out = strings.ReplaceAll(out, "{start}", start.Format("2006-01-02 15-04-05"))
	out = strings.ReplaceAll(out, "{end}", end.Format("2006-01-02 15-04-05"))
	out = strings.ReplaceAll(out, "{start_unix}", fmt.Sprintf("%d", replay.StartTime))
	out = strings.ReplaceAll(out, "{end_unix}", fmt.Sprintf("%d", replay.EndTime))

	return strings.TrimSpace(out)
}

func buildFinalPath(outputDir string, filenameTemplate string, replay model.BilibiliReplay) string {
	name := sanitizeFilename(renderFilenameTemplate(filenameTemplate, replay))
	if !strings.HasSuffix(strings.ToLower(name), ".mp4") {
		name += ".mp4"
	}
	return filepath.Join(outputDir, name)
}

func uniquePath(dst string) string {
	if _, err := os.Stat(dst); err != nil {
		return dst
	}
	ext := filepath.Ext(dst)
	base := strings.TrimSuffix(filepath.Base(dst), ext)
	dir := filepath.Dir(dst)
	for i := 1; ; i++ {
		cand := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(cand); err != nil {
			return cand
		}
	}
}

func renameExistingDownloadedFiles(outputDir string, filenameTemplate string) (int, error) {
	outputDir = filepath.Clean(outputDir)
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return 0, err
	}

	replays, err := db.GetReplays()
	if err != nil {
		return 0, err
	}

	type moved struct {
		from string
		to   string
	}
	var movedList []moved

	renamed := 0
	for i := range replays {
		if replays[i].Status != "completed" {
			continue
		}
		if replays[i].FilePath == "" {
			continue
		}
		src := replays[i].FilePath
		if _, err := os.Stat(src); err != nil {
			continue
		}

		dst := buildFinalPath(outputDir, filenameTemplate, replays[i])
		dst = uniquePath(dst)
		if filepath.Clean(src) == filepath.Clean(dst) {
			continue
		}

		if err := moveFile(src, dst); err != nil {
			for j := len(movedList) - 1; j >= 0; j-- {
				_ = moveFile(movedList[j].to, movedList[j].from)
			}
			return renamed, err
		}
		if err := db.DB.Model(&model.BilibiliReplay{}).Where("id = ?", replays[i].ID).Update("file_path", dst).Error; err != nil {
			_ = moveFile(dst, src)
			for j := len(movedList) - 1; j >= 0; j-- {
				_ = moveFile(movedList[j].to, movedList[j].from)
			}
			return renamed, err
		}

		movedList = append(movedList, moved{from: src, to: dst})
		renamed++
	}
	return renamed, nil
}

func resolveReplayFilePath(outputDir string, liveKey string, filePath string) (string, bool) {
	fp := strings.TrimSpace(filePath)
	if fp == "" {
		found, ok := findReplayFileByLiveKey(outputDir, liveKey)
		return found, ok
	}
	if filepath.IsAbs(fp) {
		return fp, true
	}
	if strings.TrimSpace(outputDir) == "" {
		return fp, true
	}
	return filepath.Join(outputDir, fp), true
}

func findReplayFileByLiveKey(outputDir string, liveKey string) (string, bool) {
	if strings.TrimSpace(outputDir) == "" || strings.TrimSpace(liveKey) == "" {
		return "", false
	}
	patterns := []string{
		filepath.Join(outputDir, "*"+liveKey+"*.mp4"),
		filepath.Join(outputDir, "*"+liveKey+"*.mkv"),
		filepath.Join(outputDir, "*"+liveKey+"*.flv"),
	}
	for _, pat := range patterns {
		matches, _ := filepath.Glob(pat)
		if len(matches) > 0 {
			return matches[0], true
		}
	}
	return "", false
}

func isSubpath(parent string, child string) (bool, error) {
	pAbs, err := filepath.Abs(parent)
	if err != nil {
		return false, err
	}
	cAbs, err := filepath.Abs(child)
	if err != nil {
		return false, err
	}
	pAbs = filepath.Clean(pAbs)
	cAbs = filepath.Clean(cAbs)
	if runtime.GOOS == "windows" {
		pAbs = strings.ToLower(pAbs)
		cAbs = strings.ToLower(cAbs)
	}
	if !strings.HasSuffix(pAbs, string(os.PathSeparator)) {
		pAbs += string(os.PathSeparator)
	}
	return strings.HasPrefix(cAbs, pAbs), nil
}

var diskStatsMu sync.Mutex
var diskStatsCache struct {
	at    time.Time
	path  string
	stats DiskStats
	err   error
}

func getDiskStats(outputDir string, tempDir string) (DiskStats, error) {
	diskStatsMu.Lock()
	defer diskStatsMu.Unlock()
	if time.Since(diskStatsCache.at) < 10*time.Second && diskStatsCache.path == outputDir {
		return diskStatsCache.stats, diskStatsCache.err
	}

	total, free, err := getDiskTotalFree(outputDir)
	var usedBy uint64
	if err == nil {
		usedBy = uint64(dirSize(outputDir))
		if strings.TrimSpace(tempDir) != "" {
			usedBy += uint64(dirSize(tempDir))
		}
	}
	stats := DiskStats{
		Path:               outputDir,
		TotalBytes:         total,
		FreeBytes:          free,
		UsedByServiceBytes: usedBy,
	}
	diskStatsCache.at = time.Now()
	diskStatsCache.path = outputDir
	diskStatsCache.stats = stats
	diskStatsCache.err = err
	return stats, err
}

func dirSize(root string) int64 {
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return 0
	}
	var total int64
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		total += fi.Size()
		return nil
	})
	return total
}
