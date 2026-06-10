package cache

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
)

type InterfaceCache interface {
	Set(key string, value interface{}, duration time.Duration)
	Get(key string) (interface{}, bool)
	Delete(key string) bool
	DeleteByPrefix(prefix string) int
}

type Cache struct {
	mu                sync.RWMutex
	defaultExpiration time.Duration
	cleanupInterval   time.Duration
	stopCh            chan struct{}
	items             map[string]Item
}

type Item struct {
	Value      interface{}
	Created    time.Time
	Expiration int64
}

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

func (c *Cache) Delete(key string) bool {
	c.mu.Lock()

	defer c.mu.Unlock()

	if _, found := c.items[key]; !found {
		return false
	}

	delete(c.items, key)

	return true
}

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
