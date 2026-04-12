package downloader

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/api"
)

type Engine struct {
	OutputDir          string
	TempDir            string
	FilenameTemplate   string
	ConcurrentSegments int
	ProgressCh         chan<- api.ProgressUpdate
}

func NewEngine(outputDir, tempDir string, filenameTemplate string, progressCh chan<- api.ProgressUpdate) *Engine {
	if outputDir == "" {
		outputDir = "./downloads"
	}
	if tempDir == "" {
		tempDir = "./temp"
	}
	if filenameTemplate == "" {
		filenameTemplate = "{yy}-{MM}-{dd} {start:150405} {title}.mp4"
	}
	os.MkdirAll(outputDir, 0755)
	os.MkdirAll(tempDir, 0755)
	return &Engine{
		OutputDir:          outputDir,
		TempDir:            tempDir,
		FilenameTemplate:   filenameTemplate,
		ConcurrentSegments: 5,
		ProgressCh:         progressCh,
	}
}

func (e *Engine) DownloadReplay(replay model.BilibiliReplay) (string, error) {
	return e.DownloadReplayWithContext(context.Background(), replay)
}

func (e *Engine) DownloadReplayWithContext(ctx context.Context, replay model.BilibiliReplay) (string, error) {
	if len(replay.Streams) == 0 {
		return "", fmt.Errorf("no streams found for replay %s", replay.LiveKey)
	}

	finalFilename := sanitizeFilename(renderFilenameTemplate(e.FilenameTemplate, replay))
	if !strings.HasSuffix(strings.ToLower(finalFilename), ".mp4") {
		finalFilename += ".mp4"
	}
	finalPath := filepath.Join(e.OutputDir, finalFilename)

	// If final file already exists and is complete, skip
	// (Though worker already checks this, double check here)
	if _, err := os.Stat(finalPath); err == nil {
		ok, _, _ := e.VerifyDuration(finalPath, replay.Duration)
		if ok {
			return finalPath, nil
		}
	}

	streams := append([]model.StreamSlice(nil), replay.Streams...)
	sort.Slice(streams, func(i, j int) bool {
		if streams[i].StartTime == streams[j].StartTime {
			return streams[i].EndTime < streams[j].EndTime
		}
		return streams[i].StartTime < streams[j].StartTime
	})

	var allSegmentFiles []string
	var allSegmentDurations []float64
	var streamTempDirs []string
	startTime := time.Now()
	var expectedSecondsFromM3U8 float64

	// Speed tracking
	var downloadedBytes int64
	var mu sync.Mutex
	speedHistory := make([]float64, 0)

	for streamIdx, stream := range streams {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		// 1. Get segments from m3u8
		segments, segDurations, totalDur, err := e.parseM3U8(ctx, stream.Stream)
		if err != nil {
			return "", fmt.Errorf("failed to parse m3u8 for stream %d: %v", streamIdx, err)
		}
		if totalDur > 0 {
			expectedSecondsFromM3U8 += totalDur
		}

		streamTempDir := filepath.Join(e.TempDir, fmt.Sprintf("%s_stream%d", replay.LiveKey, streamIdx))
		os.MkdirAll(streamTempDir, 0755)
		streamTempDirs = append(streamTempDirs, streamTempDir)

		// 2. Download segments concurrently
		concurrentDownloads := e.ConcurrentSegments
		if concurrentDownloads <= 0 {
			concurrentDownloads = 5
		}
		sem := make(chan struct{}, concurrentDownloads)
		var wg sync.WaitGroup

		errs := make(chan error, len(segments))

		for i, segURL := range segments {
			wg.Add(1)
			go func(idx int, url string) {
				defer wg.Done()
				select {
				case <-ctx.Done():
					return
				case sem <- struct{}{}:
				}
				defer func() { <-sem }()

				if ctx.Err() != nil {
					return
				}

				segFilename := fmt.Sprintf("seg_%05d.ts", idx)
				segPath := filepath.Join(streamTempDir, segFilename)

				// Check if exists (Breakpoint resume)
				if info, err := os.Stat(segPath); err == nil && info.Size() > 0 {
					mu.Lock()
					downloadedBytes += info.Size()
					mu.Unlock()
					return
				}

				// Download
				n, err := e.downloadFile(ctx, url, segPath)
				if err != nil {
					if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
						return
					}
					errs <- fmt.Errorf("segment %d download failed: %v", idx, err)
					return
				}

				mu.Lock()
				downloadedBytes += n

				// Calculate overall progress and speed
				elapsed := time.Since(startTime).Seconds()
				speed := float64(downloadedBytes) / elapsed // bytes per second

				if e.ProgressCh != nil {
					// This is an approximation since we don't know total bytes of all segments
					// But we can use segment count progress
					overallProgress := (float64(streamIdx) / float64(len(streams)) * 100) +
						(float64(idx+1) / float64(len(segments)) / float64(len(streams)) * 100)

					speedHistory = append(speedHistory, speed/1024/1024) // MB/s
					if len(speedHistory) > 30 {
						speedHistory = speedHistory[len(speedHistory)-30:]
					}

					e.ProgressCh <- api.ProgressUpdate{
						LiveKey:      replay.LiveKey,
						Progress:     overallProgress,
						Status:       "downloading",
						Message:      fmt.Sprintf("Stream %d/%d, Segment %d/%d", streamIdx+1, len(streams), idx+1, len(segments)),
						Speed:        fmt.Sprintf("%.2f MB/s", speed/1024/1024),
						SpeedHistory: speedHistory,
						Elapsed:      fmt.Sprintf("%d:%02d:%02d", int(elapsed/3600), int(elapsed/60)%60, int(elapsed)%60),
					}
				}
				mu.Unlock()
			}(i, segURL)
		}

		wg.Wait()
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		close(errs)
		if len(errs) > 0 {
			return "", <-errs
		}

		// 3. Prepare for merge
		for i := 0; i < len(segments); i++ {
			allSegmentFiles = append(allSegmentFiles, filepath.Join(streamTempDir, fmt.Sprintf("seg_%05d.ts", i)))
			if i < len(segDurations) {
				allSegmentDurations = append(allSegmentDurations, segDurations[i])
			} else {
				allSegmentDurations = append(allSegmentDurations, 0)
			}
		}
	}

	// 4. Merge all segments
	if e.ProgressCh != nil {
		e.ProgressCh <- api.ProgressUpdate{
			LiveKey:       replay.LiveKey,
			Progress:      99,
			MergeProgress: 0,
			Status:        "merging",
			Message:       "Merging all segments...",
		}
	}

	concatListPath := filepath.Join(e.TempDir, fmt.Sprintf("%s_concat.txt", replay.LiveKey))
	var listContent strings.Builder
	for idx, f := range allSegmentFiles {
		absPath, _ := filepath.Abs(f)
		listContent.WriteString(fmt.Sprintf("file '%s'\n", strings.ReplaceAll(absPath, "\\", "/")))
		if idx < len(allSegmentDurations) && allSegmentDurations[idx] > 0 {
			listContent.WriteString(fmt.Sprintf("duration %.6f\n", allSegmentDurations[idx]))
		}
	}
	if err := os.WriteFile(concatListPath, []byte(listContent.String()), 0644); err != nil {
		return "", err
	}

	expectSec := replay.Duration
	if expectedSecondsFromM3U8 > 0 {
		expectSec = int(expectedSecondsFromM3U8 + 0.5)
	}

	if err := e.runFFmpegWithMergeProgress(ctx, replay.LiveKey, []string{
		"-y",
		"-f", "concat",
		"-safe", "0",
		"-i", concatListPath,
		"-fflags", "+genpts",
		"-avoid_negative_ts", "make_zero",
		"-max_interleave_delta", "0",
		"-movflags", "+faststart",
		"-c", "copy",
		"-bsf:a", "aac_adtstoasc",
		"-progress", "pipe:1",
		"-nostats",
		finalPath,
	}, expectedSecondsFromM3U8); err != nil {
		return "", fmt.Errorf("failed to merge segments: %v", err)
	}

	ok, dur, verr := e.VerifyDuration(finalPath, expectSec)
	if verr != nil {
		return "", verr
	}
	if !ok {
		if e.ProgressCh != nil {
			e.ProgressCh <- api.ProgressUpdate{
				LiveKey:       replay.LiveKey,
				Progress:      99,
				MergeProgress: 99,
				Status:        "merging",
				Message:       "Duration looks wrong, trying a safer merge...",
			}
		}

		remuxPath := finalPath + ".remux.mp4"
		_ = os.Remove(remuxPath)
		if err := e.runFFmpegWithMergeProgress(ctx, replay.LiveKey, []string{
			"-y",
			"-i", finalPath,
			"-fflags", "+genpts",
			"-avoid_negative_ts", "make_zero",
			"-max_interleave_delta", "0",
			"-movflags", "+faststart",
			"-c", "copy",
			"-progress", "pipe:1",
			"-nostats",
			remuxPath,
		}, expectedSecondsFromM3U8); err == nil {
			if okR, durR, _ := e.VerifyDuration(remuxPath, expectSec); okR {
				_ = os.Remove(finalPath)
				_ = os.Rename(remuxPath, finalPath)
				ok = true
				dur = durR
			}
		}
		_ = os.Remove(remuxPath)
	}
	if !ok {
		if e.ProgressCh != nil {
			e.ProgressCh <- api.ProgressUpdate{
				LiveKey:       replay.LiveKey,
				Progress:      99,
				MergeProgress: 99,
				Status:        "merging",
				Message:       "Duration still looks wrong, re-encoding for stable timestamps...",
			}
		}
		fixPath := finalPath + ".fix.mp4"
		_ = os.Remove(fixPath)
		if err := e.runFFmpegWithMergeProgress(ctx, replay.LiveKey, []string{
			"-y",
			"-f", "concat",
			"-safe", "0",
			"-i", concatListPath,
			"-fflags", "+genpts",
			"-avoid_negative_ts", "make_zero",
			"-max_interleave_delta", "0",
			"-movflags", "+faststart",
			"-c:v", "libx264",
			"-preset", "veryfast",
			"-crf", "20",
			"-c:a", "aac",
			"-b:a", "160k",
			"-progress", "pipe:1",
			"-nostats",
			fixPath,
		}, expectedSecondsFromM3U8); err != nil {
			return "", fmt.Errorf("merged file duration abnormal (expected %ds, got %.2fs); retry merge failed: %v", replay.Duration, dur, err)
		}
		ok2, dur2, verr2 := e.VerifyDuration(fixPath, expectSec)
		if verr2 != nil {
			return "", verr2
		}
		if !ok2 {
			return "", fmt.Errorf("merged file duration abnormal (expected %ds, got %.2fs; retry got %.2fs)", expectSec, dur, dur2)
		}
		_ = os.Remove(finalPath)
		if err := os.Rename(fixPath, finalPath); err != nil {
			return "", err
		}
	}

	// 5. Cleanup (only after a verified merge)
	_ = os.Remove(concatListPath)
	for _, d := range streamTempDirs {
		_ = os.RemoveAll(d)
	}
	if parts, _ := filepath.Glob(filepath.Join(e.TempDir, replay.LiveKey+"_part*.part")); len(parts) > 0 {
		for _, p := range parts {
			_ = os.Remove(p)
		}
	}

	if e.ProgressCh != nil {
		e.ProgressCh <- api.ProgressUpdate{
			LiveKey:       replay.LiveKey,
			Progress:      100,
			MergeProgress: 100,
			Status:        "completed",
			Message:       "Download and merge finished",
		}
	}

	return finalPath, nil
}

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
}

func (e *Engine) parseM3U8(ctx context.Context, url string) ([]string, []float64, float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, 0, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()

	var segments []string
	var durations []float64
	scanner := bufio.NewScanner(resp.Body)
	baseURL := url[:strings.LastIndex(url, "/")+1]
	nextDur := 0.0

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			if strings.HasPrefix(line, "#EXTINF:") {
				raw := strings.TrimPrefix(line, "#EXTINF:")
				raw = strings.TrimSpace(raw)
				if idx := strings.Index(raw, ","); idx >= 0 {
					raw = raw[:idx]
				}
				if v, err := strconv.ParseFloat(raw, 64); err == nil {
					nextDur = v
				}
			}
			continue
		}
		if !strings.HasPrefix(line, "http") {
			// Relative URL
			line = baseURL + line
		}
		segments = append(segments, line)
		durations = append(durations, nextDur)
		nextDur = 0
	}
	total := 0.0
	for _, d := range durations {
		total += d
	}
	return segments, durations, total, scanner.Err()
}

func (e *Engine) runFFmpegWithMergeProgress(ctx context.Context, liveKey string, args []string, expectedSeconds float64) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	var stderrBuf bytes.Buffer
	go func() {
		_, _ = io.Copy(&stderrBuf, stderr)
	}()

	if err := cmd.Start(); err != nil {
		return err
	}

	lastSentAt := time.Time{}
	lastPct := -1
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "out_time_ms=") {
			raw := strings.TrimPrefix(line, "out_time_ms=")
			ms, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				continue
			}
			pct := 0
			if expectedSeconds > 0 {
				pct = int(float64(ms) / (expectedSeconds * 1000000.0) * 100.0)
				if pct < 0 {
					pct = 0
				}
				if pct > 100 {
					pct = 100
				}
			}
			now := time.Now()
			if pct != lastPct && (lastSentAt.IsZero() || now.Sub(lastSentAt) >= 700*time.Millisecond) {
				lastPct = pct
				lastSentAt = now
				if e.ProgressCh != nil {
					e.ProgressCh <- api.ProgressUpdate{
						LiveKey:       liveKey,
						Progress:      99,
						MergeProgress: float64(pct),
						Status:        "merging",
						Message:       fmt.Sprintf("Merging… %d%%", pct),
					}
				}
			}
		}
	}

	_ = scanner.Err()
	if err := cmd.Wait(); err != nil {
		out := stderrBuf.Bytes()
		if len(out) > 4000 {
			out = out[len(out)-4000:]
		}
		return fmt.Errorf("%v: %s", err, bytes.TrimSpace(out))
	}
	return nil
}

func (e *Engine) downloadFile(ctx context.Context, url string, path string) (int64, error) {
	tmpPath := path + ".tmp"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("bad status: %s", resp.Status)
	}

	out, err := os.Create(tmpPath)
	if err != nil {
		return 0, err
	}
	defer out.Close()

	n, err := io.Copy(out, resp.Body)
	if err != nil {
		os.Remove(tmpPath)
		return 0, err
	}
	out.Close()

	if err := os.Rename(tmpPath, path); err != nil {
		return 0, err
	}

	return n, nil
}

type FileInfo struct {
	Size       int64
	Resolution string
	Bitrate    string
}

func (e *Engine) GetFileInfo(filePath string) (FileInfo, error) {
	// ffprobe -v error -show_entries format=size,bit_rate -show_entries stream=width,height -of json <file>
	cmd := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=size,bit_rate", "-show_entries", "stream=width,height", "-of", "json", filePath)
	output, err := cmd.Output()
	if err != nil {
		return FileInfo{}, err
	}

	var res struct {
		Format struct {
			Size    string `json:"size"`
			BitRate string `json:"bit_rate"`
		} `json:"format"`
		Streams []struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output, &res); err != nil {
		return FileInfo{}, err
	}

	size, _ := strconv.ParseInt(res.Format.Size, 10, 64)
	bitrateInt, _ := strconv.ParseInt(res.Format.BitRate, 10, 64)
	bitrate := fmt.Sprintf("%.2f Mbps", float64(bitrateInt)/1000000.0)
	resolution := ""
	if len(res.Streams) > 0 {
		resolution = fmt.Sprintf("%dx%d", res.Streams[0].Width, res.Streams[0].Height)
	}

	return FileInfo{
		Size:       size,
		Resolution: resolution,
		Bitrate:    bitrate,
	}, nil
}

func (e *Engine) DownloadCover(url string, liveKey string) (string, error) {
	os.MkdirAll(filepath.Join(e.OutputDir, "covers"), 0755)
	ext := filepath.Ext(url)
	if ext == "" {
		ext = ".jpg"
	}
	filename := liveKey + ext
	localPath := filepath.Join(e.OutputDir, "covers", filename)

	// Use curl or http client
	cmd := exec.Command("curl", "-L", "-o", localPath, url)
	if err := cmd.Run(); err != nil {
		return "", err
	}

	return filename, nil
}

func (e *Engine) VerifyDuration(filePath string, expectedSeconds int) (bool, float64, error) {
	// ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 -of json <file>
	cmd := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", filePath)
	output, err := cmd.Output()
	if err != nil {
		return false, 0, err
	}

	var res struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(output, &res); err != nil {
		return false, 0, err
	}

	duration, err := strconv.ParseFloat(res.Format.Duration, 64)
	if err != nil {
		return false, 0, err
	}

	if expectedSeconds <= 0 {
		if duration <= 0 {
			return false, duration, nil
		}
		return duration < 24*3600, duration, nil
	}
	if duration > 24*3600 && expectedSeconds < 24*3600 {
		return false, duration, nil
	}
	if duration > float64(expectedSeconds)*2+600 {
		return false, duration, nil
	}

	diff := duration - float64(expectedSeconds)
	if diff < 0 {
		diff = -diff
	}

	// 1 minute margin = 60 seconds
	return diff <= 60, duration, nil
}

func sanitizeFilename(name string) string {
	// Simple sanitizer for Windows/Linux
	badChars := []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|"}
	for _, char := range badChars {
		name = strings.ReplaceAll(name, char, "_")
	}
	return name
}

var (
	startLayoutRe = regexp.MustCompile(`\{start:([^}]+)\}`)
	endLayoutRe   = regexp.MustCompile(`\{end:([^}]+)\}`)
)

func renderFilenameTemplate(tpl string, replay model.BilibiliReplay) string {
	start := time.Unix(replay.StartTime, 0)
	end := time.Unix(replay.EndTime, 0)

	out := tpl

	out = startLayoutRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := startLayoutRe.FindStringSubmatch(m)
		if len(sub) != 2 {
			return m
		}
		return start.Format(sub[1])
	})
	out = endLayoutRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := endLayoutRe.FindStringSubmatch(m)
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
