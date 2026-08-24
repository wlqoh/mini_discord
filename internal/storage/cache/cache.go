// Package cache is a thread-safe, in-memory TTL cache used by
// internal/storage/postgresql to avoid round-tripping to Postgres for hot,
// short-lived reads (membership checks, channel/server lookups) and by the
// link-preview cache tiers.
package cache

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
)

// InterfaceCache is the interface Cache implements; callers depend on this
// rather than the concrete type so it can be swapped or mocked.
type InterfaceCache interface {
	// Set stores value under key. duration is the entry's TTL; zero means
	// use the cache's default expiration, and a cache constructed with a
	// zero default (duration 0 passed through) never expires that entry.
	Set(key string, value interface{}, duration time.Duration)
	// Get returns the value stored under key and whether it was found and
	// not yet expired. An expired entry is evicted as a side effect of Get,
	// in addition to the periodic background sweep.
	Get(key string) (interface{}, bool)
	// Delete removes key and reports whether it was present.
	Delete(key string) bool
	// DeleteByPrefix removes every key with the given prefix and returns
	// how many were removed.
	DeleteByPrefix(prefix string) int
}

// Cache is an in-memory, mutex-protected TTL map with an optional
// background goroutine that periodically evicts expired entries.
type Cache struct {
	mu                sync.RWMutex
	defaultExpiration time.Duration
	cleanupInterval   time.Duration
	stopCh            chan struct{}
	items             map[string]Item
}

// Item is one entry of Cache, exported so InterfaceCache implementations
// built on Cache's internals can inspect it.
type Item struct {
	Value      interface{}
	Created    time.Time
	Expiration int64 // UnixNano; zero means the entry never expires
}

// NewCache creates a Cache with defaultExpiration used by Set calls that
// pass duration 0, and registers a background goroutine (via
// internal/lib/closer) that sweeps expired entries every cleanupInterval.
// Passing cleanupInterval <= 0 disables the background sweep; entries still
// expire lazily on Get.
func NewCache(defaultExpiration, cleanupInterval time.Duration) *Cache {

	items := make(map[string]Item)

	cache := Cache{
		items:             items,
		defaultExpiration: defaultExpiration,
		cleanupInterval:   cleanupInterval,
		stopCh:            make(chan struct{}),
	}

	if cleanupInterval > 0 {
		cache.startGC()
	}

	closer.Add("cache", func(ctx context.Context) error {
		close(cache.stopCh)
		return nil
	})

	return &cache
}

// Set implements InterfaceCache.
func (c *Cache) Set(key string, value interface{}, duration time.Duration) {

	var expiration int64

	if duration == 0 {
		duration = c.defaultExpiration
	}

	if duration > 0 {
		expiration = time.Now().Add(duration).UnixNano()
	}

	c.mu.Lock()

	defer c.mu.Unlock()

	c.items[key] = Item{
		Value:      value,
		Expiration: expiration,
		Created:    time.Now(),
	}
}

// Get implements InterfaceCache.
func (c *Cache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	item, ok := c.items[key]
	c.mu.RUnlock()

	if !ok {
		return nil, false
	}

	if item.Expiration > 0 {
		if time.Now().UnixNano() > item.Expiration {
			c.mu.Lock()
			if current, exists := c.items[key]; exists && current.Expiration == item.Expiration {
				delete(c.items, key)
			}
			c.mu.Unlock()
			return nil, false
		}
	}

	return item.Value, true
}

// Delete implements InterfaceCache.
func (c *Cache) Delete(key string) bool {
	c.mu.Lock()

	defer c.mu.Unlock()

	if _, found := c.items[key]; !found {
		return false
	}

	delete(c.items, key)

	return true
}

// DeleteByPrefix implements InterfaceCache with an O(n) scan of all entries.
func (c *Cache) DeleteByPrefix(prefix string) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	count := 0
	for key := range c.items {
		if strings.HasPrefix(key, prefix) {
			delete(c.items, key)
			count++
		}
	}
	return count
}

func (c *Cache) startGC() {
	go c.gc()
}

func (c *Cache) gc() {
	ticker := time.NewTicker(c.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			c.evictExpired()
		case <-c.stopCh:
			return
		}
	}
}

func (c *Cache) evictExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now().UnixNano()
	for key, item := range c.items {
		if item.Expiration > 0 && now > item.Expiration {
			delete(c.items, key)
		}
	}
}
