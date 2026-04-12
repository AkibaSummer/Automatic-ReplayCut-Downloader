package model

import (
	"time"

	"gorm.io/gorm"
)

// BilibiliReplay represents a replay from Bilibili API and stored in DB
type BilibiliReplay struct {
	gorm.Model
	ReplayID   int           `gorm:"uniqueIndex" json:"replay_id"`
	LiveKey    string        `gorm:"uniqueIndex" json:"live_key"`
	RoomID     int           `json:"room_id"`
	Title      string        `json:"title"`
	StartTime  int64         `json:"start_time"`
	EndTime    int64         `json:"end_time"`
	Duration   int           `json:"duration"` // Seconds
	FilePath   string        `json:"file_path"`
	CoverURL   string        `json:"cover_url"`
	LocalCover string        `json:"local_cover"`
	FileSize   int64         `json:"file_size"`
	Resolution string        `json:"resolution"`
	Bitrate    string        `json:"bitrate"`
	Progress   float64       `json:"progress"`
	Speed      string        `json:"speed"`
	Elapsed    string        `json:"elapsed"`
	ETA        string        `json:"eta"`
	Status     string        `json:"status"`  // "pending", "downloading", "completed", "failed"
	Message    string        `json:"message"` // Error or status message
	VerifyOk   bool          `json:"verify_ok"`
	ActualDur  float64       `json:"actual_duration"`
	Streams    []StreamSlice `gorm:"foreignKey:ReplayID;references:ReplayID" json:"streams"`
}

// StreamSlice represents a segment of a replay
type StreamSlice struct {
	gorm.Model
	ReplayID  int    `json:"replay_id"`
	StartTime int64  `json:"start_time"`
	EndTime   int64  `json:"end_time"`
	Stream    string `json:"stream"` // m3u8 URL
	Type      int    `json:"type"`
	M3U8Text  string `json:"m3u8_text"`
}

func FormatDuration(seconds int) string {
	d := time.Duration(seconds) * time.Second
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	return time.Date(0, 0, 0, h, m, s, 0, time.UTC).Format("15:04:05")
}
