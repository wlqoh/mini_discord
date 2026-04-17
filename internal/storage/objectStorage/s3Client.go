package objectStorage

import (
	"bytes"
	"context"
	"log"
	"mime"
	"path/filepath"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/wlqoh/mini_discord.git/internal/config"
)

type S3Client struct {
	s3Client *s3.Client
	cfg      *config.Config
}

func NewS3Client(cfg *config.Config) *S3Client {
	awsCfg, err := awsconfig.LoadDefaultConfig(
		context.TODO(),
		awsconfig.WithRegion(cfg.S3.Region),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.S3.AccessKeyID, cfg.S3.SecretAccessKey, ""),
		),
	)
	if err != nil {
		log.Fatal(err)
	}

	client := s3.NewFromConfig(awsCfg)

	return &S3Client{client, cfg}
}

func (s3Client *S3Client) PutAvatar(ctx context.Context, key string, data []byte, filename string) (string, error) {
	contentType := mime.TypeByExtension(filepath.Ext(filename))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	_, err := s3Client.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s3Client.cfg.S3.Bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", err
	}
	return s3Client.cfg.S3HOST + key, nil
}
