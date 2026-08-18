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
	JWTSecret                     string            `yaml:"jwt_secret" env-required:"true" env:"JWT_SECRET"`
	JWTAccessExpirationInMinutes  int               `yaml:"jwt_access_expiration_in_minutes" env-default:"10080"`  // 1 week
	JWTRefreshExpirationInMinutes int               `yaml:"jwt_refresh_expiration_in_minutes" env-default:"43200"` // 1 month
	Mail                          MailConfig        `yaml:"mail"`
	FrontendBaseURL               string            `yaml:"frontend_base_url" env:"FRONTEND_BASE_URL" env-default:"http://localhost:5173"`
	Push                          PushConfig        `yaml:"push"`
	LinkPreview                   LinkPreviewConfig `yaml:"link_preview"`
}

type LinkPreviewConfig struct {
	Enabled bool `yaml:"enabled" env:"LINK_PREVIEW_ENABLED" env-default:"true"`
	// Общий дедлайн одного исходящего запроса. Держим заметно ниже
	// http_server.timeout (4s), чтобы прокси картинок успевал ответить.
	Timeout       time.Duration `yaml:"timeout" env:"LINK_PREVIEW_TIMEOUT" env-default:"5s"`
	MaxBodyBytes  int64         `yaml:"max_body_bytes" env:"LINK_PREVIEW_MAX_BODY_BYTES" env-default:"524288"`
	MaxImageBytes int64         `yaml:"max_image_bytes" env:"LINK_PREVIEW_MAX_IMAGE_BYTES" env-default:"2097152"`
	MaxRedirects  int           `yaml:"max_redirects" env:"LINK_PREVIEW_MAX_REDIRECTS" env-default:"3"`
	// Сколько живёт удачное превью и сколько — отрицательный результат.
	// Негативный TTL короче: сайт мог просто временно лежать.
	CacheTTL    time.Duration `yaml:"cache_ttl" env:"LINK_PREVIEW_CACHE_TTL" env-default:"168h"`
	NegativeTTL time.Duration `yaml:"negative_cache_ttl" env:"LINK_PREVIEW_NEGATIVE_TTL" env-default:"6h"`
	Workers     int           `yaml:"workers" env:"LINK_PREVIEW_WORKERS" env-default:"4"`
	UserAgent   string        `yaml:"user_agent" env:"LINK_PREVIEW_USER_AGENT" env-default:"MiniDiscordBot/1.0 (+link preview)"`
}

type PushConfig struct {
	Enabled      bool   `yaml:"enabled" env:"PUSH_ENABLED" env-default:"false"`
	VAPIDPublic  string `yaml:"vapid_public_key" env:"VAPID_PUBLIC_KEY"`
	VAPIDPrivate string `yaml:"vapid_private_key" env:"VAPID_PRIVATE_KEY"`
	Subject      string `yaml:"vapid_subject" env:"VAPID_SUBJECT" env-default:"mailto:admin@example.com"`
	TTLSeconds   int    `yaml:"ttl_seconds" env:"PUSH_TTL_SECONDS" env-default:"43200"`
}

type MailConfig struct {
	SMTPHost     string `yaml:"smtp_host" env:"SMTP_HOST"`
	SMTPPort     int    `yaml:"smtp_port" env:"SMTP_PORT" env-default:"587"`
	SMTPUsername string `yaml:"smtp_username" env:"SMTP_USERNAME"`
	SMTPPassword string `yaml:"smtp_password" env:"SMTP_PASSWORD"`
	FromAddress  string `yaml:"from_address" env:"MAIL_FROM_ADDRESS"`
	FromName     string `yaml:"from_name" env:"MAIL_FROM_NAME" env-default:"Mini Discord"`
}

type WebRTCConfig struct {
	TurnURLs                  []string `yaml:"turn_urls" env:"TURN_URLS" env-separator:","`
	TurnStaticAuthSecret      string   `yaml:"turn_static_auth_secret" env:"TURN_STATIC_AUTH_SECRET"`
	TurnCredentialsTTLSeconds int      `yaml:"turn_credentials_ttl_seconds" env:"TURN_CREDENTIALS_TTL_SECONDS" env-default:"600"`

	SFU SFUConfig `yaml:"sfu"`
}

type SFUConfig struct {
	Enabled bool `yaml:"enabled" env:"SFU_ENABLED" env-default:"false"`

	// Publicly reachable IP of this server. Required when Enabled is true:
	// without it Pion advertises host ICE candidates using the container's
	// internal address (e.g. 172.x.x.x) and ICE never connects for anyone.
	PublicIP string `yaml:"public_ip" env:"SFU_PUBLIC_IP"`

	UDPPort  int      `yaml:"udp_port" env:"SFU_UDP_PORT" env-default:"7881"`
	StunURLs []string `yaml:"stun_urls" env:"SFU_STUN_URLS" env-separator:","`

	MaxRoomParticipants int           `yaml:"max_room_participants" env:"SFU_MAX_ROOM_PARTICIPANTS" env-default:"20"`
	SessionGracePeriod  time.Duration `yaml:"session_grace_period" env:"SFU_SESSION_GRACE_PERIOD" env-default:"30s"`
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
