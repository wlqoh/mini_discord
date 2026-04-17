package types

import "context"

type S3ClientStorage interface {
	PutAvatar(ctx context.Context, key string, data []byte, filename string) (string, error)
}
