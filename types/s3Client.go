package types

import "context"

// S3ClientStorage is implemented by the object-storage client
// (internal/storage/objectStorage) and wraps the S3-compatible operations
// the app needs for user avatars and message attachments.
type S3ClientStorage interface {
	// PutAvatar uploads data under key and returns the object's public URL.
	PutAvatar(ctx context.Context, key string, data []byte, filename string) (string, error)
	// PutAttachment uploads data under key, tagged with contentType, and
	// returns the object's public URL. uniqueSuffix is appended to avoid
	// collisions between attachments with the same original filename.
	PutAttachment(ctx context.Context, key string, data []byte, filename string, contentType string, uniqueSuffix string) (string, error)
	// DeleteAttachment removes the objects at keys; it is used with the S3
	// keys returned by ServerStorage.DeleteMessage.
	DeleteAttachment(ctx context.Context, keys []string) error
}
