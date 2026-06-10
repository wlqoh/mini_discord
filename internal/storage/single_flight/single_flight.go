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

type SingleFlight struct {
	mu    sync.Mutex
	calls map[string]*call
}

func NewSingleFlight() *SingleFlight {
	return &SingleFlight{
		calls: make(map[string]*call),
	}
}

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
