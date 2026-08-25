// Package closer is a process-wide, thread-safe registry of shutdown
// callbacks (the DB pool, the token-bucket cleanup goroutine, ...), run in
// LIFO order by CloseAll.
package closer

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
)

type closeFn struct {
	name string
	fn   func(ctx context.Context) error
}

type closer struct {
	mu    sync.Mutex
	once  sync.Once
	funcs []closeFn
}

var globalCloser = &closer{}

// Add registers fn to run during shutdown, labeled name for logging.
// Registered functions run in LIFO order (most recently added runs first)
// when CloseAll is called.
func Add(name string, fn func(ctx context.Context) error) {
	globalCloser.add(name, fn)
}

// CloseAll runs every function registered via Add, in LIFO order, each
// bounded by ctx (further capped to 10s internally). It runs at most once
// per process — later calls are no-ops that return nil — and joins every
// callback's error into the single returned error.
func CloseAll(log *slog.Logger, ctx context.Context) error {
	return globalCloser.closeAll(log, ctx)
}

func (c *closer) closeAll(log *slog.Logger, ctx context.Context) error {
	var result error
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c.once.Do(func() {
		c.mu.Lock()
		funcs := c.funcs
		c.funcs = nil
		c.mu.Unlock()

		if len(funcs) == 0 {
			return
		}

		log.Info("closing functions", slog.Int("count", len(funcs)))

		var errs []error

		for i := len(funcs) - 1; i >= 0; i-- {
			f := funcs[i]

			start := time.Now()
			log.Info("closing function", slog.String("name", f.name))

			if err := f.fn(ctx); err != nil {
				log.Error("error closing function", slog.String("name", f.name), sl.Err(err), slog.Duration("duration", time.Since(start)))

				errs = append(errs, err)
			} else {
				log.Info("successfully closed function", slog.String("name", f.name), slog.Duration("duration", time.Since(start)))
			}
		}

		log.Info("all functions closed")

		result = errors.Join(errs...)
	})

	return result
}
func (c *closer) add(name string, fn func(ctx context.Context) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.funcs = append(c.funcs, closeFn{name, fn})
}
