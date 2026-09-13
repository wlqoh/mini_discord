package postgresql

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/wlqoh/mini_discord.git/types"
)

// testStorage opens a connection to a real local Postgres for integration
// tests of DM behavior: the invariants under test (UNIQUE + ON CONFLICT
// races, UNION ALL branches, notification cascade fallbacks) are properties
// of the SQL itself, not of Go glue code, so a mock would only prove the
// mock's own expectations were met. DB_URL defaults to the same DSN
// local.env points dev at; set it explicitly to point elsewhere.
func testStorage(t *testing.T) *Storage {
	t.Helper()
	dsn := os.Getenv("DB_URL")
	if dsn == "" {
		dsn = "postgresql://murad:123@localhost:5432/postgres?sslmode=disable"
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	st, err := New(dsn, log)
	if err != nil {
		t.Skipf("skipping DM storage tests: no reachable Postgres at %s: %v", dsn, err)
	}
	return st
}

// testUser inserts a throwaway user and registers its cleanup.
func testUser(t *testing.T, st *Storage) int {
	t.Helper()
	ctx := context.Background()
	suffix := rand.Int63()
	var id int
	err := st.db.QueryRowContext(ctx, `
		INSERT INTO users (first_name, last_name, nickname, email, password)
		VALUES ('Test', 'User', $1, $2, 'x')
		RETURNING id
	`, fmt.Sprintf("dmtest_%d", suffix), fmt.Sprintf("dmtest_%d@x.test", suffix)).Scan(&id)
	if err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", id)
	})
	return id
}

// testServerWithMembers inserts a throwaway server owned by ownerID with
// memberIDs (which must include ownerID if the owner should count as a
// member) and registers its cleanup.
func testServerWithMembers(t *testing.T, st *Storage, ownerID int, memberIDs ...int) int64 {
	t.Helper()
	ctx := context.Background()
	var serverID int64
	if err := st.db.QueryRowContext(ctx,
		`INSERT INTO servers (name, owner_id) VALUES ('dmtest', $1) RETURNING id`, ownerID,
	).Scan(&serverID); err != nil {
		t.Fatalf("insert test server: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM servers WHERE id = $1", serverID)
	})
	for _, uid := range memberIDs {
		if _, err := st.db.ExecContext(ctx,
			`INSERT INTO server_members (user_id, server_id) VALUES ($1, $2)`, uid, serverID,
		); err != nil {
			t.Fatalf("insert server member: %v", err)
		}
	}
	return serverID
}

// --- §7.1: CanUserAccessChannel and DM ---

func TestCanUserAccessChannel_DM(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	stranger := testUser(t, st)
	testServerWithMembers(t, st, a, a, b)

	channelID, created, err := st.OpenDMChannel(ctx, a, b)
	if err != nil {
		t.Fatalf("OpenDMChannel: %v", err)
	}
	if !created {
		t.Fatal("expected new DM channel to be created")
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", channelID)
	})

	if ok, err := st.CanUserAccessChannel(ctx, a, channelID); err != nil || !ok {
		t.Fatalf("initiator should have access: ok=%v err=%v", ok, err)
	}
	if ok, err := st.CanUserAccessChannel(ctx, b, channelID); err != nil || !ok {
		t.Fatalf("peer should have access: ok=%v err=%v", ok, err)
	}
	if ok, err := st.CanUserAccessChannel(ctx, stranger, channelID); err != nil || ok {
		t.Fatalf("stranger should NOT have access to a DM channel just for sharing a server with neither participant: ok=%v err=%v", ok, err)
	}

	// A third user who shares a server with one of the participants — but
	// isn't a participant of the DM itself — must not gain access merely by
	// virtue of server membership (decision #9: existing-DM access is
	// membership in the DM, not shared-server membership).
	outsider := testUser(t, st)
	testServerWithMembers(t, st, a, a, outsider)
	if ok, err := st.CanUserAccessChannel(ctx, outsider, channelID); err != nil || ok {
		t.Fatalf("server-mate of a participant should NOT have DM access: ok=%v err=%v", ok, err)
	}
}

// --- §7.2: pair uniqueness ---

func TestOpenDMChannel_PairUniqueness(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	testServerWithMembers(t, st, a, a, b)

	ch1, created1, err := st.OpenDMChannel(ctx, a, b)
	if err != nil {
		t.Fatalf("OpenDMChannel(a,b): %v", err)
	}
	if !created1 {
		t.Fatal("first open should report created")
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", ch1)
	})

	ch2, created2, err := st.OpenDMChannel(ctx, b, a)
	if err != nil {
		t.Fatalf("OpenDMChannel(b,a): %v", err)
	}
	if created2 {
		t.Fatal("second open (reversed args) should not report created")
	}
	if ch1 != ch2 {
		t.Fatalf("expected same channel id regardless of argument order, got %d vs %d", ch1, ch2)
	}

	var rowCount int
	if err := st.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dm_channels WHERE user_a = LEAST($1::bigint,$2::bigint) AND user_b = GREATEST($1::bigint,$2::bigint)`,
		a, b,
	).Scan(&rowCount); err != nil {
		t.Fatalf("count dm_channels rows: %v", err)
	}
	if rowCount != 1 {
		t.Fatalf("expected exactly one dm_channels row for the pair, got %d", rowCount)
	}

	// Concurrent OpenDMChannel calls for a fresh pair must still converge on
	// one channel — this is what the ON CONFLICT DO NOTHING path (rather
	// than the plain existence check) actually protects against.
	c := testUser(t, st)
	d := testUser(t, st)
	testServerWithMembers(t, st, c, c, d)

	const n = 8
	results := make(chan int64, n)
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			id, _, err := st.OpenDMChannel(ctx, c, d)
			results <- id
			errs <- err
		}()
	}
	seen := map[int64]bool{}
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent OpenDMChannel: %v", err)
		}
		seen[<-results] = true
	}
	if len(seen) != 1 {
		t.Fatalf("expected all concurrent opens to converge on one channel id, got %v", seen)
	}
	for id := range seen {
		t.Cleanup(func() {
			_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", id)
		})
	}

	var rowCount2 int
	if err := st.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dm_channels WHERE user_a = LEAST($1::bigint,$2::bigint) AND user_b = GREATEST($1::bigint,$2::bigint)`,
		c, d,
	).Scan(&rowCount2); err != nil {
		t.Fatalf("count dm_channels rows: %v", err)
	}
	if rowCount2 != 1 {
		t.Fatalf("expected exactly one dm_channels row after concurrent opens, got %d", rowCount2)
	}
}

func TestOpenDMChannel_NoSharedServer(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	// deliberately no shared server

	_, _, err := st.OpenDMChannel(ctx, a, b)
	if !errors.Is(err, types.ErrNoSharedServer) {
		t.Fatalf("expected ErrNoSharedServer, got %v", err)
	}
}

// --- §7.3: DM must not leak into server-scoped reads ---

func TestDMChannelsDoNotLeak(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	serverID := testServerWithMembers(t, st, a, a, b)

	dmChannelID, _, err := st.OpenDMChannel(ctx, a, b)
	if err != nil {
		t.Fatalf("OpenDMChannel: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", dmChannelID)
	})

	token := fmt.Sprintf("uniquetoken%d", rand.Int63())
	msg := &types.WsMessage{ChannelID: dmChannelID, AuthorID: a, Content: "secret dm about " + token}
	if err := st.SaveMessage(ctx, msg); err != nil {
		t.Fatalf("SaveMessage into DM channel: %v", err)
	}

	channels, err := st.GetServerChannels(ctx, serverID)
	if err != nil {
		t.Fatalf("GetServerChannels: %v", err)
	}
	for _, ch := range channels {
		if ch.ID == dmChannelID {
			t.Fatalf("GetServerChannels leaked the DM channel: %+v", ch)
		}
	}

	hits, _, _, err := st.SearchMessages(ctx, types.MessageSearchParams{
		Query:    token,
		ServerID: serverID,
		Limit:    10,
	}, "")
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	for _, hit := range hits {
		if hit.ChannelID == dmChannelID {
			t.Fatalf("SearchMessages with server scope leaked a DM message: %+v", hit)
		}
	}

	// Sanity check the other direction: channel-scoped search on the DM
	// channel itself does find the message (it's only the server-scope
	// leak that's under test above).
	hits, _, _, err = st.SearchMessages(ctx, types.MessageSearchParams{
		Query:     token,
		ChannelID: dmChannelID,
		Limit:     10,
	}, "")
	if err != nil {
		t.Fatalf("SearchMessages (channel scope): %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected to find the DM message via channel-scoped search, got %d hits", len(hits))
	}
}

// TestDeleteChannelRejectsDMChannel is invariant #4 from docs/dm-plan.md §4.6:
// DeleteChannel's ownership check joins channels to servers, so a DM channel
// (server_id IS NULL) can never match that join and must come back as "not
// found" rather than silently succeeding for whichever participant happens
// to look like a server owner elsewhere.
func TestDeleteChannelRejectsDMChannel(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	testServerWithMembers(t, st, a, a, b)

	channelID, _, err := st.OpenDMChannel(ctx, a, b)
	if err != nil {
		t.Fatalf("OpenDMChannel: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", channelID)
	})

	if err := st.DeleteChannel(ctx, channelID, a); err == nil {
		t.Fatal("expected DeleteChannel to refuse a DM channel, got nil error")
	}

	isDM, err := st.IsDMChannel(ctx, channelID)
	if err != nil {
		t.Fatalf("IsDMChannel: %v", err)
	}
	if !isDM {
		t.Fatal("DM channel was deleted despite DeleteChannel returning an error")
	}
}

// --- §7.4: visibility lifecycle ---

func TestListDMChannels_VisibilityLifecycle(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	testServerWithMembers(t, st, a, a, b)

	channelID, _, err := st.OpenDMChannel(ctx, a, b)
	if err != nil {
		t.Fatalf("OpenDMChannel: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", channelID)
	})

	contains := func(channels []types.DMChannel, id int64) bool {
		for _, c := range channels {
			if c.ChannelID == id {
				return true
			}
		}
		return false
	}

	// Before the first message: only the initiator (a) sees the DM.
	listA, err := st.ListDMChannels(ctx, a, "")
	if err != nil {
		t.Fatalf("ListDMChannels(a): %v", err)
	}
	if !contains(listA, channelID) {
		t.Fatal("expected initiator to see the DM before the first message")
	}
	listB, err := st.ListDMChannels(ctx, b, "")
	if err != nil {
		t.Fatalf("ListDMChannels(b): %v", err)
	}
	if contains(listB, channelID) {
		t.Fatal("expected peer to NOT see the DM before the first message")
	}

	// After the first message (simulated by the hub's RevealDMChannel call):
	// both sides see it.
	if err := st.RevealDMChannel(ctx, channelID); err != nil {
		t.Fatalf("RevealDMChannel: %v", err)
	}
	listB, err = st.ListDMChannels(ctx, b, "")
	if err != nil {
		t.Fatalf("ListDMChannels(b) after reveal: %v", err)
	}
	if !contains(listB, channelID) {
		t.Fatal("expected peer to see the DM after the first message")
	}

	// After close_dm: hidden for whoever closed it, untouched for the other
	// side.
	if err := st.HideDMChannel(ctx, a, channelID); err != nil {
		t.Fatalf("HideDMChannel(a): %v", err)
	}
	listA, err = st.ListDMChannels(ctx, a, "")
	if err != nil {
		t.Fatalf("ListDMChannels(a) after close: %v", err)
	}
	if contains(listA, channelID) {
		t.Fatal("expected the DM to be hidden for a after close_dm")
	}
	listB, err = st.ListDMChannels(ctx, b, "")
	if err != nil {
		t.Fatalf("ListDMChannels(b) after a's close: %v", err)
	}
	if !contains(listB, channelID) {
		t.Fatal("expected b's visibility to be unaffected by a's close_dm")
	}

	// A new incoming message reveals it again for the side that closed it.
	if err := st.RevealDMChannel(ctx, channelID); err != nil {
		t.Fatalf("RevealDMChannel (new incoming): %v", err)
	}
	listA, err = st.ListDMChannels(ctx, a, "")
	if err != nil {
		t.Fatalf("ListDMChannels(a) after new incoming: %v", err)
	}
	if !contains(listA, channelID) {
		t.Fatal("expected the DM to be visible again for a after a new incoming message")
	}
}

// --- §7.5: notifications ---

func TestResolveNotificationTargets_DM(t *testing.T) {
	st := testStorage(t)
	ctx := context.Background()

	a := testUser(t, st)
	b := testUser(t, st)
	testServerWithMembers(t, st, a, a, b)

	channelID, _, err := st.OpenDMChannel(ctx, a, b)
	if err != nil {
		t.Fatalf("OpenDMChannel: %v", err)
	}
	t.Cleanup(func() {
		_, _ = st.db.ExecContext(context.Background(), "DELETE FROM channels WHERE id = $1", channelID)
	})

	// b's global default is 'mentions' — without the DM-branch fix this
	// would leak through and silence the DM.
	if _, err := st.db.ExecContext(ctx,
		`INSERT INTO user_notification_settings (user_id, default_level) VALUES ($1, 'mentions')`, b,
	); err != nil {
		t.Fatalf("insert user_notification_settings: %v", err)
	}

	targets, err := st.ResolveNotificationTargets(ctx, channelID, []int{b})
	if err != nil {
		t.Fatalf("ResolveNotificationTargets: %v", err)
	}
	if len(targets) != 1 {
		t.Fatalf("expected 1 target, got %d", len(targets))
	}
	if targets[0].Level != "all" {
		t.Fatalf("expected DM level to fall back to 'all' despite global default_level='mentions', got %q", targets[0].Level)
	}
	if targets[0].MutedUntil != nil {
		t.Fatalf("expected no mute yet, got %v", targets[0].MutedUntil)
	}

	// Muting this DM channel specifically must still work.
	mutedUntil := time.Now().Add(time.Hour).UTC()
	if _, err := st.db.ExecContext(ctx,
		`INSERT INTO channel_notification_settings (user_id, channel_id, muted_until) VALUES ($1, $2, $3)`,
		b, channelID, mutedUntil,
	); err != nil {
		t.Fatalf("insert channel_notification_settings: %v", err)
	}
	targets, err = st.ResolveNotificationTargets(ctx, channelID, []int{b})
	if err != nil {
		t.Fatalf("ResolveNotificationTargets after mute: %v", err)
	}
	if targets[0].MutedUntil == nil || !targets[0].MutedUntil.After(time.Now()) {
		t.Fatalf("expected MutedUntil in the future after muting the DM channel, got %v", targets[0].MutedUntil)
	}

	// Global DND must still apply to DMs.
	dndUntil := time.Now().Add(time.Hour).UTC()
	if _, err := st.db.ExecContext(ctx,
		`UPDATE user_notification_settings SET dnd_until = $2 WHERE user_id = $1`, b, dndUntil,
	); err != nil {
		t.Fatalf("update dnd_until: %v", err)
	}
	targets, err = st.ResolveNotificationTargets(ctx, channelID, []int{b})
	if err != nil {
		t.Fatalf("ResolveNotificationTargets after dnd: %v", err)
	}
	if targets[0].DNDUntil == nil || !targets[0].DNDUntil.After(time.Now()) {
		t.Fatalf("expected DNDUntil in the future after enabling DND, got %v", targets[0].DNDUntil)
	}
}
