// Package sl holds small slog.Attr helpers shared across the codebase.
package sl

import "log/slog"

// Err returns a slog.Attr for err under the conventional "error" key.
func Err(err error) slog.Attr {
	return slog.Attr{
		Key:   "error",
		Value: slog.StringValue(err.Error()),
	}
}
