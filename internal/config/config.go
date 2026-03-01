package config

import (
	"log"
	"os"
	"sync"
	"time"

	"github.com/ilyakaznacheev/cleanenv"
)

type Config struct {
	Env                    string `yaml:"env" env-default:"local"`
	StoragePath            string `yaml:"storage_path" env-required:"true"`
	HTTPServer             `yaml:"http_server"`
	JWTSecret              string `yaml:"jwt_secret" env-required:"true" env:"JWT_SECRET"`
	JWTExpirationInSeconds int    `yaml:"jwt_expiration_in_seconds" env-default:"604800"` // 7 days
}

type HTTPServer struct {
	Address     string        `yaml:"host" env-default:"localhost:8080"`
	Timeout     time.Duration `yaml:"timeout" env-default:"4s"`
	IdleTimeout time.Duration `yaml:"idle_timeout" env-default:"60s"`
	User        string        `yaml:"user" env-required:"true"`
	Password    string        `yaml:"password" env-required:"true" env:"HTTP_SERVER_PASSWORD"`
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
