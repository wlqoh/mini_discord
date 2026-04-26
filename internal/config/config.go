package config

import (
	"log"
	"os"
	"sync"
	"time"

	"github.com/ilyakaznacheev/cleanenv"
)

type Config struct {
	Env                           string       `yaml:"env" env-default:"local"`
	StoragePath                   string       `yaml:"storage_path" env-required:"true"`
	S3HOST                        string       `yaml:"S3_HOST" env-default:"https://storage.yandexcloud.net/"`
	S3                            S3Config     `yaml:"s3"`
	WebRTC                        WebRTCConfig `yaml:"webrtc"`
	HTTPServer                    `yaml:"http_server"`
	JWTSecret                     string `yaml:"jwt_secret" env-required:"true" env:"JWT_SECRET"`
	JWTAccessExpirationInMinutes  int    `yaml:"jwt_access_expiration_in_minutes" env-default:"10080"`  // 1 week
	JWTRefreshExpirationInMinutes int    `yaml:"jwt_refresh_expiration_in_minutes" env-default:"43200"` // 1 month
}

type WebRTCConfig struct {
	TurnURLs                  []string `yaml:"turn_urls" env:"TURN_URLS" env-separator:","`
	TurnStaticAuthSecret      string   `yaml:"turn_static_auth_secret" env:"TURN_STATIC_AUTH_SECRET"`
	TurnCredentialsTTLSeconds int      `yaml:"turn_credentials_ttl_seconds" env:"TURN_CREDENTIALS_TTL_SECONDS" env-default:"600"`
}

type S3Config struct {
	Endpoint        string `yaml:"endpoint" env:"S3_ENDPOINT" env-default:"https://storage.yandexcloud.net"`
	Region          string `yaml:"region" env:"S3_REGION" env-default:"ru-central1"`
	Bucket          string `yaml:"bucket" env:"S3_BUCKET" env-required:"true"`
	AccessKeyID     string `yaml:"access_key_id" env:"S3_ACCESS_KEY_ID" env-required:"true"`
	SecretAccessKey string `yaml:"secret_access_key" env:"S3_SECRET_ACCESS_KEY" env-required:"true"`
}

type HTTPServer struct {
	Address          string        `yaml:"host" env-default:"localhost:8080"`
	Timeout          time.Duration `yaml:"timeout" env-default:"4s"`
	IdleTimeout      time.Duration `yaml:"idle_timeout" env-default:"60s"`
	User             string        `yaml:"user" env-required:"true"`
	Password         string        `yaml:"password" env-required:"true" env:"HTTP_SERVER_PASSWORD"`
	CORSOrigins      []string      `yaml:"cors_allowed_origins" env-default:"*" env-separator:","`
	WSAllowedOrigins []string      `yaml:"ws_allowed_origins" env-separator:","`
}

var (
	instance *Config
	once     sync.Once
)

func MustLoad() *Config {
	once.Do(func() {
		configPath := os.Getenv("CONFIG_PATH")
		if configPath == "" {
			log.Fatal("CONFIG_PATH environment variable not set")
		}

		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			log.Fatalf("CONFIG_PATH does not exist: %s", configPath)
		}

		var cfg Config

		if err := cleanenv.ReadConfig(configPath, &cfg); err != nil {
			log.Fatalf("Error reading config: %s", err)
		}

		instance = &cfg
	})

	return instance
}
