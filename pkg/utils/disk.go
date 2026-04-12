package utils

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type DiskStats struct {
	Path               string `json:"path"`
	TotalBytes         uint64 `json:"total_bytes"`
	FreeBytes          uint64 `json:"free_bytes"`
	UsedByServiceBytes uint64 `json:"used_by_service_bytes"`
}

var diskStatsMu sync.Mutex
var diskStatsCache struct {
	at    time.Time
	path  string
	stats DiskStats
	err   error
}

func GetDiskStats(outputDir string, tempDir string) (DiskStats, error) {
	diskStatsMu.Lock()
	defer diskStatsMu.Unlock()
	if time.Since(diskStatsCache.at) < 10*time.Second && diskStatsCache.path == outputDir {
		return diskStatsCache.stats, diskStatsCache.err
	}

	total, free, err := GetDiskTotalFree(outputDir)
	var usedBy uint64
	if err == nil {
		usedBy = uint64(DirSize(outputDir))
		if strings.TrimSpace(tempDir) != "" {
			usedBy += uint64(DirSize(tempDir))
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

func DirSize(root string) int64 {
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
