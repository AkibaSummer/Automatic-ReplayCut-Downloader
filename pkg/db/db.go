package db

import (
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

var DB *gorm.DB

func InitDB(dsn string) error {
	var err error
	DB, err = gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		return err
	}

	// Auto Migrate
	return DB.AutoMigrate(&model.BilibiliReplay{}, &model.StreamSlice{})
}

func SaveReplay(replay *model.BilibiliReplay) error {
	return DB.Save(replay).Error
}

func GetReplays() ([]model.BilibiliReplay, error) {
	var replays []model.BilibiliReplay
	err := DB.Preload("Streams").Order("start_time desc").Find(&replays).Error
	return replays, err
}

func GetReplayByLiveKey(liveKey string) (*model.BilibiliReplay, error) {
	var replay model.BilibiliReplay
	err := DB.Preload("Streams").Where("live_key = ?", liveKey).First(&replay).Error
	if err != nil {
		return nil, err
	}
	return &replay, nil
}

func ReplaceReplayStreams(replayID int, streams []model.StreamSlice) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("replay_id = ?", replayID).Delete(&model.StreamSlice{}).Error; err != nil {
			return err
		}
		if len(streams) == 0 {
			return nil
		}
		for i := range streams {
			streams[i].ID = 0
			streams[i].ReplayID = replayID
		}
		return tx.Create(&streams).Error
	})
}
