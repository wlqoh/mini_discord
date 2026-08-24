// Package config defines Config, the application's configuration schema,
// and MustLoad, which loads it exactly once.
//
// Config is populated from a YAML file named by the CONFIG_PATH environment
// variable, then overlaid field-by-field from the environment for every
// field carrying an `env:` struct tag (JWT_SECRET, S3_*, TURN_*, SFU_*,
// PUSH_*, LINK_PREVIEW_*, and more — see the tags on each field below). A
// field tagged `env-required:"true"` must resolve to a non-empty value
// from one of those two sources or MustLoad exits the process; this file
// is the authoritative list of which fields those are.
//
// MustLoad is a singleton via sync.Once: the first call loads and caches
// the config, every later call returns the same *Config.
package config
