// Package objectStorage is an S3-compatible client (AWS SDK v2, path-style
// requests) for user avatars and message attachments, used against Yandex
// Object Storage. It implements types.S3ClientStorage.
package objectStorage

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"mime"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/utils"
)

// S3Client is the AWS SDK v2-backed implementation of types.S3ClientStorage.
type S3Client struct {
	s3Client *s3.Client
	cfg      *config.Config
	log      *slog.Logger
}

// NewS3Client builds an S3Client from cfg.S3. It returns nil (not an error)
// if the bucket or credentials are missing from config, or if the AWS SDK
// fails to load its configuration; either case is logged via log.
func NewS3Client(cfg *config.Config, log *slog.Logger) *S3Client {
	if strings.TrimSpace(cfg.S3.Bucket) == "" || strings.TrimSpace(cfg.S3.AccessKeyID) == "" || strings.TrimSpace(cfg.S3.SecretAccessKey) == "" {
		log.Error("s3 configuration is incomplete")
		return nil
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(
		context.Background(),
		awsconfig.WithRegion(cfg.S3.Region),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.S3.AccessKeyID, cfg.S3.SecretAccessKey, ""),
		),
	)
	if err != nil {
		log.Error("failed to load AWS configuration", sl.Err(err))
		return nil
	}

	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(cfg.S3.Endpoint)
		o.UsePathStyle = true
	})

	return &S3Client{s3Client, cfg, log}
}

// PutAvatar implements types.S3ClientStorage, storing data under the
// "avatars/" prefix and returning its public URL. Content type is guessed
// from filename's extension.
func (s3Client *S3Client) PutAvatar(ctx context.Context, key string, data []byte, filename string) (string, error) {
	contentType := mime.TypeByExtension(filepath.Ext(filename))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	_, err := s3Client.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s3Client.cfg.S3.Bucket),
		Key:         aws.String(fmt.Sprintf("avatars/%s", key)),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", err
	}

	return utils.AvatarURLFromKey(key, s3Client.cfg.S3HOST), nil
}

// DeleteAttachment implements types.S3ClientStorage, deleting all keys in
// one batch request; an empty keys is a no-op.
func (s3Client *S3Client) DeleteAttachment(ctx context.Context, keys []string) error {

	objects := make([]types.ObjectIdentifier, 0, len(keys))
	if len(keys) == 0 {
		return nil
	}
	for _, key := range keys {
		objects = append(objects, types.ObjectIdentifier{
			Key: aws.String(key),
		})

	}

	_, err := s3Client.s3Client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(s3Client.cfg.S3.Bucket),
		Delete: &types.Delete{
			Objects: objects,
			Quiet:   aws.Bool(true),
		},
	})

	if err != nil {
		return err
	}

	return nil
}

// PutAttachment implements types.S3ClientStorage, storing data under
// "attachments/{key}/{uniqueSuffix}_{filename}" and returning its public
// URL. If contentType is empty it is guessed from filename's extension.
func (s3Client *S3Client) PutAttachment(ctx context.Context, key string, data []byte, filename string, contentType string, uniqueSuffix string) (string, error) {
	if contentType == "" {
		contentType = mime.TypeByExtension(filepath.Ext(filename))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	}

	s3Key := fmt.Sprintf("attachments/%s/%s_%s", key, uniqueSuffix, filename)

	_, err := s3Client.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s3Client.cfg.S3.Bucket),
		Key:         aws.String(s3Key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", err
	}

	return utils.AvatarURLFromKey(s3Key, s3Client.cfg.S3HOST), nil
}
