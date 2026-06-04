package closer

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
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

func Add(name string, fn func(ctx context.Context) error) {
	globalCloser.add(name, fn)
}

func CloseAll(ctx context.Context) error {
	return globalCloser.closeAll(ctx)
}

func (c *closer) closeAll(ctx context.Context) error {
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

		slog.Info("closing functions", "count", len(funcs))

		var errs []error

		for i := len(funcs) - 1; i >= 0; i-- {
			f := funcs[i]

			start := time.Now()
			slog.Info("closing function", "name", f.name)

			if err := f.fn(ctx); err != nil {
				slog.Error("error closing function", "name", f.name, "error", err, "duration", time.Since(start))

				errs = append(errs, err)
			} else {
				slog.Info("successfully closed function", "name", f.name, "duration", time.Since(start))
			}
		}

		slog.Info("all functions closed")

		result = errors.Join(errs...)
	})

	return result
}
func (c *closer) add(name string, fn func(ctx context.Context) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.funcs = append(c.funcs, closeFn{name, fn})
}
