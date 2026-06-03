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
	"github.com/wlqoh/mini_discord.git/utils"
)

type S3Client struct {
	s3Client *s3.Client
	cfg      *config.Config
	log      *slog.Logger
}

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
		log.Error("failed to load AWS configuration", "error", err.Error())
		return nil
	}

	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(cfg.S3.Endpoint)
		o.UsePathStyle = true
	})

	return &S3Client{s3Client, cfg, log}
}

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
