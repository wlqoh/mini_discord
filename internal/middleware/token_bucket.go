package middleware

import (
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/utils"
)

type TokenBucket struct {
	mu              sync.Mutex
	tokensPerSecond float64
	maxTokens       float64
	tokens          map[string]*bucketState
	cleanupInterval time.Duration
	stopCh          chan struct{}
	startOnce       sync.Once
	stopOnce        sync.Once
}

type bucketState struct {
	tokens     float64
	lastRefill time.Time
}

func NewTokenBucket(tokensPerSecond float64, maxTokens float64) *TokenBucket {
	tb := &TokenBucket{
		tokensPerSecond: tokensPerSecond,
		maxTokens:       maxTokens,
		tokens:          make(map[string]*bucketState),
		cleanupInterval: 5 * time.Minute,
		stopCh:          make(chan struct{}),
	}
	tb.Start()
	return tb
}

func (tb *TokenBucket) Start() {
	tb.startOnce.Do(func() {
		go tb.cleanup()
	})
}

func (tb *TokenBucket) Close() {
	tb.stopOnce.Do(func() {
		close(tb.stopCh)
	})
}

func (tb *TokenBucket) Allow(clientID string) bool {
	if clientID == "" {
		clientID = "unknown"
	}

	tb.mu.Lock()
	defer tb.mu.Unlock()

	now := time.Now()
	bucket, exists := tb.tokens[clientID]

	if !exists {
		bucket = &bucketState{
			tokens:     tb.maxTokens - 1,
			lastRefill: now,
		}
		tb.tokens[clientID] = bucket
		return true
	}

	elapsed := now.Sub(bucket.lastRefill).Seconds()
	bucket.tokens = min(bucket.tokens+elapsed*tb.tokensPerSecond, tb.maxTokens)
	bucket.lastRefill = now

	if bucket.tokens >= 1.0 {
		bucket.tokens -= 1.0
		return true
	}

	return false
}

func (tb *TokenBucket) FiberRateLimitMiddleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !tb.Allow(c.IP()) {
			return utils.WriteError(c, fiber.StatusTooManyRequests, "rate limit exceeded")
		}
		return c.Next()
	}
}

func (tb *TokenBucket) cleanup() {
	ticker := time.NewTicker(tb.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			tb.mu.Lock()
			now := time.Now()
			for key, state := range tb.tokens {
				if now.Sub(state.lastRefill) > tb.cleanupInterval {
					delete(tb.tokens, key)
				}
			}
			tb.mu.Unlock()
		case <-tb.stopCh:
			return
		}
	}
}
