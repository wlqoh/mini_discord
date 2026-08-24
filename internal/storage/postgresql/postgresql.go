package postgresql

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
	"github.com/wlqoh/mini_discord.git/internal/storage/cache"
	"github.com/wlqoh/mini_discord.git/internal/storage/single_flight"
)

// Storage is the Postgres-backed implementation of every storage interface
// declared in types (ServerStorage, UserStorage, NotificationStorage,
// EmbedStorage): raw SQL via lib/pq, no ORM. cache and sf back the
// link-preview cache tiers used by embeds.go.
type Storage struct {
	db    *sql.DB
	cache cache.InterfaceCache
	sf    *single_flight.SingleFlight
}

const (
	userIDKey         = "user:id:"
	serversUserKey    = "servers:user:"
	channelsServerKey = "channels:server:"
	channelKey        = "channel:"
	memberKey         = "member:"
	accessKey         = "access:"
	membersServerKey  = "members:server:"
	membersKey        = "members:"
)

// New opens a Postgres connection pool at storagePath (a postgres:// DSN),
// pings it to fail fast on a bad connection, and registers the pool with
// closer for shutdown. The returned Storage owns its own in-memory cache
// and single-flight group.
func New(storagePath string) (*Storage, error) {
	const op = "storage.postgresql.New"

	db, err := sql.Open("postgres", storagePath)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("%s: failed to connect %w", op, err)
	}

	closer.Add("postgresql", func(ctx context.Context) error {
		return db.Close()
	})
	cacheStore := cache.NewCache(5*time.Minute, 10*time.Minute)
	sf := single_flight.NewSingleFlight()

	return &Storage{db: db, cache: cacheStore, sf: sf}, nil
}
