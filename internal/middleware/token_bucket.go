package middleware

import (
	"context"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
	"github.com/wlqoh/mini_discord.git/utils"
)

// TokenBucket is a thread-safe, per-key token-bucket rate limiter: each
// distinct key (a client IP for FiberRateLimitMiddleware, or a user ID for
// hub actions like create_server/send_message/mark_read) gets its own
// independent bucket that refills at tokensPerSecond up to maxTokens.
// Idle buckets are swept periodically so the map doesn't grow unbounded.
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

// NewTokenBucket builds a TokenBucket that refills at tokensPerSecond
// tokens/second up to a burst of maxTokens, starts its background cleanup
// goroutine (Start), and registers that goroutine's shutdown with
// internal/lib/closer.
func NewTokenBucket(tokensPerSecond float64, maxTokens float64) *TokenBucket {
	tb := &TokenBucket{
		tokensPerSecond: tokensPerSecond,
		maxTokens:       maxTokens,
		tokens:          make(map[string]*bucketState),
		cleanupInterval: 5 * time.Minute,
		stopCh:          make(chan struct{}),
	}
	tb.Start()

	closer.Add("tokenBucket", func(ctx context.Context) error {
		close(tb.stopCh)

		return nil
	})
	return tb
}

// Start launches the background goroutine that periodically evicts idle
// per-key buckets. It is idempotent — only the first call has any effect —
// since NewTokenBucket already calls it.
func (tb *TokenBucket) Start() {
	tb.startOnce.Do(func() {
		go tb.cleanup()
	})
}

// Allow reports whether clientID may proceed, consuming one token from its
// bucket if so. An empty clientID is treated as the literal key "unknown"
// (so a caller that failed to resolve one still gets a single shared
// bucket rather than an unbounded number of unlimited requests). Safe for
// concurrent use.
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

// FiberRateLimitMiddleware returns Fiber middleware that rate-limits by
// client IP (c.IP()), responding 429 when the bucket is empty.
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
