package api

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/config"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/db"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/utils"
	"github.com/gin-gonic/gin"
)

type RouterCtx struct {
	Config *config.Config
}

func HandleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func HandleVersion(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"version":    BuildVersion,
		"commit":     BuildCommit,
		"build_time": BuildTime,
	})
}

func HandleRuntime(c *gin.Context) {
	if workerInstance == nil {
		c.JSON(http.StatusOK, Runtime{})
		return
	}
	c.JSON(http.StatusOK, workerInstance.GetRuntime())
}

func (r *RouterCtx) HandleDiskStats(c *gin.Context) {
	if r.Config == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Config not loaded"})
		return
	}
	out := strings.TrimSpace(r.Config.Download.OutputDir)
	if out == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "output_dir is empty"})
		return
	}
	stats, err := utils.GetDiskStats(out, strings.TrimSpace(r.Config.Download.TempDir))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Convert utils.DiskStats to our response format (they match, but type conversion might be needed if they differ. They are identical since we copied the struct)
	c.JSON(http.StatusOK, stats)
}

func HandleFsList(c *gin.Context) {
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
}

func (r *RouterCtx) HandleGetConfig(c *gin.Context) {
	if r.Config == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Config not loaded"})
		return
	}
	c.JSON(http.StatusOK, r.Config)
}

func HandleGetMe(c *gin.Context) {
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
}

func HandleGetAvatar(c *gin.Context) {
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
}

// Config mutation helpers mapping from utils
func (r *RouterCtx) HandleUpdateConfig(c *gin.Context) {
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
	
	oldCfg := *r.Config
	oldOutputDir := oldCfg.Download.OutputDir
	
	// Preserve system parameters not exposed/sent by UI
	newCfg.Server = oldCfg.Server
	if newCfg.Database.DSN == "" {
		newCfg.Database = oldCfg.Database
	}

	if newCfg.Bilibili.Cookies == nil {
		newCfg.Bilibili.Cookies = oldCfg.Bilibili.Cookies
	}
	if newCfg.Bilibili.CookieFile == "" {
		newCfg.Bilibili.CookieFile = oldCfg.Bilibili.CookieFile
	}
	// Do not override AnchorID if it is 0 explicitly submitted by user unless they didn't send it? 
	// Wait, actually, if the user leaves AnchorID blank, it becomes 0, which is valid (prompts them to set it).
	
	if newCfg.Download.OutputDir == "" {
		newCfg.Download.OutputDir = oldCfg.Download.OutputDir
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
	
	*r.Config = newCfg
	if err := r.Config.Save(); err != nil {
		*r.Config = oldCfg
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Header("X-Migrated-Files", fmt.Sprintf("%d", migrated))
	c.Header("X-Renamed-Files", fmt.Sprintf("%d", renamed))
	c.JSON(http.StatusOK, r.Config)
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
				if err := utils.MoveFile(src, dst); err != nil {
					log.Printf("Failed to move file %s: %v", src, err)
					// Skip this file, do not update DB, continue with others
				} else {
					replays[i].FilePath = dst
					changed = true
					moved++
				}
			}
		}

		if replays[i].LocalCover != "" {
			srcCover := filepath.Join(oldDir, "covers", replays[i].LocalCover)
			dstCover := filepath.Join(newDir, "covers", replays[i].LocalCover)
			if _, err := os.Stat(dstCover); err == nil {
			} else if _, err := os.Stat(srcCover); err == nil {
				if err := utils.MoveFile(srcCover, dstCover); err != nil {
					log.Printf("Failed to move cover %s: %v", srcCover, err)
					// Skip to next, non-blocking
				} else {
					moved++
				}
			}
		}

		if changed {
			db.SaveReplay(&replays[i])
		}
	}

	return moved, nil
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

		dst := utils.BuildFinalPath(outputDir, filenameTemplate, replays[i])
		dst = utils.UniquePath(dst)
		if filepath.Clean(src) == filepath.Clean(dst) {
			continue
		}

		if err := utils.MoveFile(src, dst); err != nil {
			log.Printf("Failed to rename file %s -> %s: %v", src, dst, err)
			continue
		}
		if err := db.DB.Model(&model.BilibiliReplay{}).Where("id = ?", replays[i].ID).Update("file_path", dst).Error; err != nil {
			log.Printf("Failed to update database for %s: %v", dst, err)
			continue
		}

		movedList = append(movedList, moved{from: src, to: dst})
		renamed++
	}
	return renamed, nil
}

func (r *RouterCtx) HandleGetReplays(c *gin.Context) {
	replays, err := db.GetReplays()
	if err != nil {
		fmt.Printf("Error fetching replays: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	outputDir := ""
	if r.Config != nil {
		outputDir = r.Config.Download.OutputDir
	}
	for i := range replays {
		if replays[i].Status != "completed" && replays[i].Status != "deleted" {
			continue
		}
		resolved, ok := utils.ResolveReplayFilePath(outputDir, replays[i].LiveKey, replays[i].FilePath)
		if ok && resolved != "" && replays[i].FilePath != resolved {
			replays[i].FilePath = resolved
			_ = db.SaveReplay(&replays[i])
		}
		if resolved == "" || !ok {
			if replays[i].Status == "completed" {
				replays[i].Status = "deleted"
				replays[i].VerifyOk = false
				replays[i].Message = "Downloaded before but file path is unknown or missing. You can re-download."
				_ = db.SaveReplay(&replays[i])
			}
			continue
		}
		if _, err := os.Stat(resolved); err != nil {
			if found, okFound := utils.FindReplayFileByLiveKey(outputDir, replays[i].LiveKey); okFound && found != "" {
				replays[i].FilePath = found
				if replays[i].Status == "deleted" {
					replays[i].Status = "completed"
					replays[i].VerifyOk = true
					replays[i].Message = "Success"
				}
				_ = db.SaveReplay(&replays[i])
				continue
			}
			if replays[i].Status == "completed" {
				replays[i].Status = "deleted"
				replays[i].VerifyOk = false
				replays[i].Message = "Downloaded before but file was deleted locally. You can re-download."
				_ = db.SaveReplay(&replays[i])
			}
		} else if replays[i].Status == "deleted" {
			replays[i].Status = "completed"
			replays[i].VerifyOk = true
			replays[i].Message = "Success"
			_ = db.SaveReplay(&replays[i])
		}
	}
	c.JSON(http.StatusOK, replays)
}

func HandleScan(c *gin.Context) {
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
}

func HandleSyncAll(c *gin.Context) {
	if workerInstance != nil {
		go workerInstance.SyncAll()
		c.JSON(http.StatusOK, gin.H{"message": "Sync started"})
	} else {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
	}
}

func HandleCleanupStale(c *gin.Context) {
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
}

func HandleCleanupStreams(c *gin.Context) {
	if workerInstance == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
		return
	}
	count, err := workerInstance.CleanupDuplicateStreams()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Stream cleanup finished", "count": count})
}

func HandlePauseAll(c *gin.Context) {
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
}

func HandleResumeAll(c *gin.Context) {
	if workerInstance == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
		return
	}
	if err := workerInstance.ResumeAll(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Resumed"})
}

func HandleDownloadUnfinished(c *gin.Context) {
	if workerInstance == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
		return
	}
	if err := workerInstance.DownloadUnfinished(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Downloading unfinished"})
}

func HandleRetryAllFailed(c *gin.Context) {
	if workerInstance == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
		return
	}
	if err := workerInstance.RetryAllFailed(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Retrying failed tasks"})
}

func HandleDownloadReplay(c *gin.Context) {
	liveKey := c.Param("live_key")
	if workerInstance != nil {
		go workerInstance.DownloadReplay(liveKey)
		c.JSON(http.StatusOK, gin.H{"message": "Download started"})
	} else {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Worker not initialized"})
	}
}

func HandlePauseReplay(c *gin.Context) {
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
}

func HandleResumeReplay(c *gin.Context) {
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
}

func (r *RouterCtx) HandleDeleteFile(c *gin.Context) {
	if r.Config == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Config not loaded"})
		return
	}
	liveKey := c.Param("live_key")
	replay, err := db.GetReplayByLiveKey(liveKey)
	if err != nil || replay == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "replay not found"})
		return
	}
	resolved, _ := utils.ResolveReplayFilePath(r.Config.Download.OutputDir, replay.LiveKey, replay.FilePath)
	if resolved == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file_path is empty"})
		return
	}
	ok, err := utils.IsSubpath(r.Config.Download.OutputDir, resolved)
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
}

func HandleCacheM3U8(c *gin.Context) {
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
}

func HandleExportTsv(c *gin.Context) {
	replays, err := db.GetReplays()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	sort.Slice(replays, func(i, j int) bool {
		return replays[i].ReplayID < replays[j].ReplayID
	})

	var buf bytes.Buffer
	buf.WriteString("replay_id\tstart_time\tend_time\tlive_key\t直播标题\tstream\n")

	useProxy := c.Query("proxy") == "true"
	host := c.Request.Host
	schema := "http"
	if c.Request.TLS != nil || c.Request.Header.Get("X-Forwarded-Proto") == "https" {
		schema = "https"
	}

	for _, r := range replays {
		title := strings.ReplaceAll(strings.ReplaceAll(r.Title, "\n", " "), "\t", " ")
		if len(r.Streams) > 0 {
			sort.Slice(r.Streams, func(i, j int) bool {
				return r.Streams[i].StartTime < r.Streams[j].StartTime
			})
			for i, s := range r.Streams {
				urlToUse := s.Stream
				if useProxy {
					urlToUse = fmt.Sprintf("%s://%s/api/preview/%s/%d.m3u8", schema, host, r.LiveKey, i)
				}
				buf.WriteString(fmt.Sprintf("%d\t%d\t%d\t%s\t%s\t%s\n", r.ReplayID, r.StartTime, r.EndTime, r.LiveKey, title, urlToUse))
			}
		} else {
			buf.WriteString(fmt.Sprintf("%d\t%d\t%d\t%s\t%s\t\n", r.ReplayID, r.StartTime, r.EndTime, r.LiveKey, title))
		}
	}

	c.Header("Content-Disposition", "attachment; filename=replays_export.tsv")
	c.Data(http.StatusOK, "text/tab-separated-values; charset=utf-8", buf.Bytes())
}

func HandlePreviewM3U8(c *gin.Context) {
	liveKey := c.Param("live_key")
	streamIdxStr := c.Param("stream_idx")
	streamIdx, err := strconv.Atoi(streamIdxStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid stream index"})
		return
	}

	replay, err := db.GetReplayByLiveKey(liveKey)
	if err != nil || replay == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Replay not found"})
		return
	}

	if len(replay.Streams) == 0 {
		c.String(http.StatusNotFound, "No streams found")
		return
	}

	sort.Slice(replay.Streams, func(i, j int) bool {
		return replay.Streams[i].StartTime < replay.Streams[j].StartTime
	})

	if streamIdx < 0 || streamIdx >= len(replay.Streams) {
		c.String(http.StatusNotFound, "Stream index out of bounds")
		return
	}

	stream := replay.Streams[streamIdx]
	if stream.M3U8Text == "" {
		c.String(http.StatusNotFound, "M3U8 text not cached. Please cache M3U8 for this replay first.")
		return
	}

	c.Data(http.StatusOK, "application/vnd.apple.mpegurl", []byte(stream.M3U8Text))
}

// Auth Handlers
func HandleGenerateQR(c *gin.Context) {
	url, key, err := workerInstance.GenerateQR()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"url":        url,
		"qrcode_key": key,
	})
}

func HandlePollQR(c *gin.Context) {
	key := c.Query("qrcode_key")
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "qrcode_key is required"})
		return
	}
	code, err := workerInstance.PollQR(key)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": code})
}
