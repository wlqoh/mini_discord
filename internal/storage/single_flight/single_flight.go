// Package single_flight collapses concurrent callers keyed by a string into
// a single in-flight execution, so a cache stampede (many goroutines
// missing the same cache key at once) results in one backing call instead
// of one per goroutine. Used by internal/storage/postgresql to deduplicate
// concurrent GetUserByID cache misses.
package single_flight

import (
	"context"
	"errors"
	"sync"
)

type call struct {
	err   error
	value interface{}
	done  chan struct{}
}

// SingleFlight deduplicates concurrent Do calls that share the same key.
type SingleFlight struct {
	mu    sync.Mutex
	calls map[string]*call
}

// NewSingleFlight returns an empty SingleFlight, safe for concurrent use.
func NewSingleFlight() *SingleFlight {
	return &SingleFlight{
		calls: make(map[string]*call),
	}
}

// Do runs action for key if no call for that key is already in flight, or
// joins the in-flight call otherwise; all callers sharing a key receive the
// same value/error. Note that action always runs with the context of the
// caller that started it — a caller that joins an in-flight call waits on
// its own ctx for cancellation, but does not affect the context action
// itself is running under. A panic inside action is recovered and turned
// into a generic error for every waiting caller, not re-panicked. The
// in-flight entry for key is removed once action returns, so the next call
// for that key starts a fresh execution.
func (s *SingleFlight) Do(ctx context.Context, key string, action func(context.Context) (interface{}, error)) (interface{}, error) {
	s.mu.Lock()
	if call, ok := s.calls[key]; ok {
		s.mu.Unlock()
		return s.wait(ctx, call)
	}

	call := &call{
		done: make(chan struct{}),
	}

	s.calls[key] = call
	s.mu.Unlock()

	go func() {
		defer func() {
			if r := recover(); r != nil {
				call.err = errors.New("error from single flight")
			}

			close(call.done)

			s.mu.Lock()
			delete(s.calls, key)
			s.mu.Unlock()
		}()

		call.value, call.err = action(ctx)
	}()

	return s.wait(ctx, call)
}
func (s *SingleFlight) wait(ctx context.Context, call *call) (interface{}, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-call.done:
		return call.value, call.err
	}
}
