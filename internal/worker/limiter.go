package worker

import (
	"context"
	"errors"
	"sync"
	"time"
)

var ErrPaused = errors.New("paused")

type taskLimiter struct {
	mu     sync.Mutex
	limit  int
	inUse  int
	paused bool
}

func newTaskLimiter(limit int) *taskLimiter {
	if limit <= 0 {
		limit = 1
	}
	return &taskLimiter{limit: limit}
}

func (l *taskLimiter) SetLimit(limit int) {
	if limit <= 0 {
		limit = 1
	}
	l.mu.Lock()
	l.limit = limit
	l.mu.Unlock()
}

func (l *taskLimiter) Pause() {
	l.mu.Lock()
	l.paused = true
	l.mu.Unlock()
}

func (l *taskLimiter) Resume() {
	l.mu.Lock()
	l.paused = false
	l.mu.Unlock()
}

func (l *taskLimiter) IsPaused() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.paused
}

func (l *taskLimiter) Acquire(ctx context.Context) error {
	for {
		l.mu.Lock()
		if l.paused {
			l.mu.Unlock()
			return ErrPaused
		}
		if l.inUse < l.limit {
			l.inUse++
			l.mu.Unlock()
			return nil
		}
		l.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (l *taskLimiter) Release() {
	l.mu.Lock()
	if l.inUse > 0 {
		l.inUse--
	}
	l.mu.Unlock()
}
