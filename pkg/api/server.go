package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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
	CleanupDuplicateStreams() (int, error)
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

	ctx := &RouterCtx{Config: cfg}

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
		apiGroup.GET("/health", HandleHealth)
		apiGroup.GET("/version", HandleVersion)
		apiGroup.GET("/runtime", HandleRuntime)
		apiGroup.GET("/stats/disk", ctx.HandleDiskStats)
		apiGroup.GET("/fs/list", HandleFsList)
		apiGroup.GET("/config", ctx.HandleGetConfig)
		apiGroup.GET("/me", HandleGetMe)
		apiGroup.GET("/avatar", HandleGetAvatar)
		apiGroup.POST("/config", ctx.HandleUpdateConfig)
		apiGroup.GET("/replays", ctx.HandleGetReplays)
		apiGroup.GET("/export-tsv", HandleExportTsv)
		apiGroup.GET("/preview/:live_key/:stream_idx.m3u8", HandlePreviewM3U8)
		apiGroup.POST("/scan", HandleScan)
		apiGroup.POST("/sync-all", HandleSyncAll)
		apiGroup.POST("/cleanup-stale", HandleCleanupStale)
		apiGroup.POST("/cleanup-streams", HandleCleanupStreams)
		apiGroup.POST("/pause-all", HandlePauseAll)
		apiGroup.POST("/resume-all", HandleResumeAll)
		apiGroup.POST("/replays/:live_key/download", HandleDownloadReplay)
		apiGroup.POST("/replays/:live_key/pause", HandlePauseReplay)
		apiGroup.POST("/replays/:live_key/resume", HandleResumeReplay)
		apiGroup.POST("/replays/:live_key/delete-file", ctx.HandleDeleteFile)
		apiGroup.POST("/replays/:live_key/cache-m3u8", HandleCacheM3U8)
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

	// Web Frontend fallback (Static matching)
	exePath, _ := os.Executable()
	baseDir := filepath.Dir(exePath)
	frontendDist := filepath.Join(baseDir, "frontend", "dist")
	if _, err := os.Stat(frontendDist); os.IsNotExist(err) {
		frontendDist = "frontend/dist" // fallback for development
	}
	r.Static("/assets", filepath.Join(frontendDist, "assets"))
	r.NoRoute(func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/api") && !strings.HasPrefix(c.Request.URL.Path, "/covers") {
			c.File(filepath.Join(frontendDist, "index.html"))
			return
		}
		c.Status(http.StatusNotFound)
	})

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	return r.Run(addr)
}
