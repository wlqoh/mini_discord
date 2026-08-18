package sfu

import (
	"testing"
	"time"
)

func TestActiveSpeakersSweep(t *testing.T) {
	a := newActiveSpeakers()

	// Nothing loud yet — no change to report.
	if ids, changed := a.sweep(); changed || len(ids) != 0 {
		t.Fatalf("expected no change on empty tracker, got ids=%v changed=%v", ids, changed)
	}

	a.markLoud(1)
	ids, changed := a.sweep()
	if !changed {
		t.Fatal("expected a change after marking user 1 loud")
	}
	if len(ids) != 1 || ids[0] != 1 {
		t.Fatalf("expected [1], got %v", ids)
	}

	// Sweeping again immediately with no new activity: same set, no change.
	if _, changed := a.sweep(); changed {
		t.Fatal("expected no change on repeated sweep with the same active set")
	}

	// A second speaker joins the set.
	a.markLoud(2)
	ids, changed = a.sweep()
	if !changed {
		t.Fatal("expected a change after marking user 2 loud")
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 active speakers, got %v", ids)
	}

	// Simulate user 1 going silent past the hold duration by rewinding its
	// timestamp directly (avoids a real sleep in the test).
	a.mu.Lock()
	a.lastLoudAt[1] = time.Now().Add(-2 * activeSpeakerHoldDuration)
	a.mu.Unlock()

	ids, changed = a.sweep()
	if !changed {
		t.Fatal("expected a change once user 1 aged out of the hold window")
	}
	if len(ids) != 1 || ids[0] != 2 {
		t.Fatalf("expected only [2] to remain active, got %v", ids)
	}

	// removeUser drops a departed peer immediately, not after the hold window.
	a.markLoud(2)
	a.sweep()
	a.removeUser(2)
	ids, changed = a.sweep()
	if !changed {
		t.Fatal("expected a change after removeUser dropped the only active speaker")
	}
	if len(ids) != 0 {
		t.Fatalf("expected no active speakers after removeUser, got %v", ids)
	}
}
