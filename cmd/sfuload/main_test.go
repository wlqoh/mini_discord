package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadTokens(t *testing.T) {
	t.Run("from -tokens only", func(t *testing.T) {
		got, err := loadTokens("aaa, bbb ,ccc", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{"aaa", "bbb", "ccc"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("from -tokens-file only, skipping blanks and comments", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "tokens.txt")
		content := "tok1\n\n# a comment\ntok2\n   \ntok3\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write tokens file: %v", err)
		}

		got, err := loadTokens("", path)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{"tok1", "tok2", "tok3"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("combines both sources", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "tokens.txt")
		if err := os.WriteFile(path, []byte("fromfile1\nfromfile2\n"), 0o600); err != nil {
			t.Fatalf("write tokens file: %v", err)
		}

		got, err := loadTokens("fromflag1,fromflag2", path)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{"fromflag1", "fromflag2", "fromfile1", "fromfile2"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("neither source", func(t *testing.T) {
		got, err := loadTokens("", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("expected no tokens, got %v", got)
		}
	})

	t.Run("missing file errors", func(t *testing.T) {
		if _, err := loadTokens("", "/nonexistent/path/tokens.txt"); err == nil {
			t.Fatal("expected an error for a missing tokens file")
		}
	})
}
