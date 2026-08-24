package config

import (
	"log"
	"os"
	"sync"
	"time"

	"github.com/ilyakaznacheev/cleanenv"
)

// Config is the application's full configuration, loaded once via MustLoad
// from a YAML file (CONFIG_PATH) with env vars overlaying any field
// carrying an `env:` tag. Fields tagged `env-required:"true"` must resolve
// to a non-empty value (from YAML or its env var) or MustLoad exits the
// process.
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

// LinkPreviewConfig configures internal/service/embed. Push notifications
// and link previews are both feature-gated by their own Enabled field
// rather than by presence of config, so a deployment can opt out cleanly.
type LinkPreviewConfig struct {
	Enabled bool `yaml:"enabled" env:"LINK_PREVIEW_ENABLED" env-default:"true"`
	// Timeout is the deadline for one outbound fetch. Kept noticeably below
	// http_server.timeout (4s) so the image proxy has time to respond
	// within its own request's deadline.
	Timeout       time.Duration `yaml:"timeout" env:"LINK_PREVIEW_TIMEOUT" env-default:"5s"`
	MaxBodyBytes  int64         `yaml:"max_body_bytes" env:"LINK_PREVIEW_MAX_BODY_BYTES" env-default:"524288"`
	MaxImageBytes int64         `yaml:"max_image_bytes" env:"LINK_PREVIEW_MAX_IMAGE_BYTES" env-default:"2097152"`
	MaxRedirects  int           `yaml:"max_redirects" env:"LINK_PREVIEW_MAX_REDIRECTS" env-default:"3"`
	// CacheTTL/NegativeTTL are how long a successful vs. a failed/empty
	// preview stays cached; the negative TTL is shorter because the site
	// may only have been down temporarily.
	CacheTTL    time.Duration `yaml:"cache_ttl" env:"LINK_PREVIEW_CACHE_TTL" env-default:"168h"`
	NegativeTTL time.Duration `yaml:"negative_cache_ttl" env:"LINK_PREVIEW_NEGATIVE_TTL" env-default:"6h"`
	Workers     int           `yaml:"workers" env:"LINK_PREVIEW_WORKERS" env-default:"4"`
	UserAgent   string        `yaml:"user_agent" env:"LINK_PREVIEW_USER_AGENT" env-default:"MiniDiscordBot/1.0 (+link preview)"`
}

// PushConfig configures internal/service/push. Web Push stays off
// (Sender.Enqueue becomes a no-op) unless Enabled is true and VAPIDPublic/
// VAPIDPrivate are both set; GET /api/v1/push/public-key returning 404 is
// the frontend's signal for this, not a bug.
type PushConfig struct {
	Enabled      bool   `yaml:"enabled" env:"PUSH_ENABLED" env-default:"false"`
	VAPIDPublic  string `yaml:"vapid_public_key" env:"VAPID_PUBLIC_KEY"`
	VAPIDPrivate string `yaml:"vapid_private_key" env:"VAPID_PRIVATE_KEY"`
	Subject      string `yaml:"vapid_subject" env:"VAPID_SUBJECT" env-default:"mailto:admin@example.com"`
	TTLSeconds   int    `yaml:"ttl_seconds" env:"PUSH_TTL_SECONDS" env-default:"43200"`
}

// MailConfig configures internal/service/mailer's outbound SMTP
// connection. A zero MailConfig (no SMTPHost/FromAddress) makes
// Mailer.Configured false, so a send attempt fails with an error; the
// registration handler logs that error but does not fail registration
// because of it.
type MailConfig struct {
	SMTPHost     string `yaml:"smtp_host" env:"SMTP_HOST"`
	SMTPPort     int    `yaml:"smtp_port" env:"SMTP_PORT" env-default:"587"`
	SMTPUsername string `yaml:"smtp_username" env:"SMTP_USERNAME"`
	SMTPPassword string `yaml:"smtp_password" env:"SMTP_PASSWORD"`
	FromAddress  string `yaml:"from_address" env:"MAIL_FROM_ADDRESS"`
	FromName     string `yaml:"from_name" env:"MAIL_FROM_NAME" env-default:"Mini Discord"`
}

// WebRTCConfig configures TURN credential minting (internal/service/webrtc)
// shared by both the mesh-era REST endpoint and the SFU's join_voice_channel
// ack, plus the embedded SFU itself.
type WebRTCConfig struct {
	TurnURLs                  []string `yaml:"turn_urls" env:"TURN_URLS" env-separator:","`
	TurnStaticAuthSecret      string   `yaml:"turn_static_auth_secret" env:"TURN_STATIC_AUTH_SECRET"`
	TurnCredentialsTTLSeconds int      `yaml:"turn_credentials_ttl_seconds" env:"TURN_CREDENTIALS_TTL_SECONDS" env-default:"600"`

	SFU SFUConfig `yaml:"sfu"`
}

// SFUConfig configures the embedded SFU (internal/service/sfu). If Enabled
// but the router fails to construct (e.g. UDPPort already in use), the
// hub logs the error and carries on with sfuRouter nil — chat keeps
// working, only join_voice_channel fails.
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

// S3Config configures internal/storage/objectStorage's S3-compatible
// client, defaulting to Yandex Object Storage. Bucket/AccessKeyID/
// SecretAccessKey are required; if incomplete, NewS3Client logs an error
// and returns nil rather than failing startup.
type S3Config struct {
	Endpoint        string `yaml:"endpoint" env:"S3_ENDPOINT" env-default:"https://storage.yandexcloud.net"`
	Region          string `yaml:"region" env:"S3_REGION" env-default:"ru-central1"`
	Bucket          string `yaml:"bucket" env:"S3_BUCKET" env-required:"true"`
	AccessKeyID     string `yaml:"access_key_id" env:"S3_ACCESS_KEY_ID" env-required:"true"`
	SecretAccessKey string `yaml:"secret_access_key" env:"S3_SECRET_ACCESS_KEY" env-required:"true"`
}

// HTTPServer configures the Fiber app's listen address/timeouts, CORS, and
// the HTTP Basic auth (User/Password) that guards the admin SFU debug
// endpoint. CORSOrigins is the general CORS allowlist; WSAllowedOrigins is
// a separate allowlist checked only for the /server/ws upgrade — see
// Handler.isWebsocketUpgraded.
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

// MustLoad loads Config from the YAML file at CONFIG_PATH (an env var, not
// a config field — see cleanenv.ReadConfig), overlaying any field with an
// `env:` tag from its environment variable, and exits the process via
// log.Fatal if CONFIG_PATH is unset, the file is missing, or loading fails
// (including an unset `env-required:"true"` field). It is a singleton:
// only the first call actually loads; later calls return the same
// *Config.
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
