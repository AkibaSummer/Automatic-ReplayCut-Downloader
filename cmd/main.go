package main

import (
	"fmt"
	"log"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/worker"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/api"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/config"
	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/pkg/db"
	"go.uber.org/zap"
)

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// 1. Init DB
	if err := db.InitDB(cfg.Database.DSN); err != nil {
		logger.Fatal("failed to init db", zap.Error(err))
	}

	// 2. Init Bilibili Client
	// 3. Start Worker
	w := worker.NewWorker(cfg, logger)
	api.SetWorker(w)

	// Start login check if not logged in
	go func() {
		if err := w.EnsureLoggedIn(); err != nil {
			logger.Error("login failed", zap.Error(err))
		}
	}()

	// Start background scanning
	w.Start()

	// 4. Start Web Server
	fmt.Printf("Starting server on :%d\n", cfg.Server.Port)
	if err := api.StartServer(cfg); err != nil {
		logger.Fatal("server exited", zap.Error(err))
	}
}
