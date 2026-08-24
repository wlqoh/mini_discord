// Package postgresql is the Postgres-backed implementation of the storage
// interfaces declared in types (ServerStorage, UserStorage,
// NotificationStorage, EmbedStorage): raw SQL via lib/pq, no ORM.
//
// Storage embeds an in-memory TTL cache (internal/storage/cache) and a
// single-flight group (internal/storage/single_flight) used to deduplicate
// concurrent cache misses; both back read paths that are hot on the hub's
// event loop (membership checks, channel/server lookups) and the
// link-preview cache tiers used by embeds.go. Most read methods that
// populate a cache also return a defensive copy, so mutating a caller's
// result cannot corrupt the cached value; writes that change what a cached
// read would return explicitly invalidate the relevant keys.
//
// Attachment and avatar URLs are never stored — every read that returns
// one takes an s3Host parameter and rebuilds the URL from the stored S3
// object key via utils, since the storage layer has no config of its own
// and the correct host depends on which request came in.
//
// Schema changes affecting this package must be mirrored in two places:
// sql/schema (goose migrations, applied by `make up`) and sql/init (the
// same DDL without goose markers, applied by docker-compose's migrate
// service). The numbering between the two directories is offset — match by
// content, not number.
package postgresql
