package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"

	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/types"
)

// TestJoinVoiceChannelRejectsDMChannel is the hub-level half of the §9
// invariant ("joinVoiceChannel по DM-каналу отклоняется"): a channel row
// whose Type is ChannelTypeDM must fail the existing "selected channel is
// not voice" check exactly like any other non-voice channel, with no
// DM-specific code path needed. The storage-level half (a DM channel can
// never itself be created with type=voice) is structural — dm_channels
// always pairs with a channels row inserted with type='dm' by
// OpenDMChannel — so this is the only place the invariant needs a test.
func TestJoinVoiceChannelRejectsDMChannel(t *testing.T) {
	storage := &fakeStorage{
		canAccess: true,
		channel:   &types.Channel{ID: 100, ServerID: 0, Type: types.ChannelTypeDM},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewHub(storage, nil, log, "", nil, nil, nil, config.WebRTCConfig{
		SFU: config.SFUConfig{Enabled: false},
	})

	cl := newTestClient(1)
	h.testRegister(cl)

	payload, _ := json.Marshal(types.WsJoinVoiceChannelRequest{ChannelID: 100})
	h.joinVoiceChannel(wsCommandRequest{
		client:  cl,
		command: types.WsCommand{Action: types.WsActionJoinVoiceChannel, Payload: payload},
	}, context.Background())

	select {
	case ev := <-cl.Outbound:
		if ev.Event != types.WsEventError {
			t.Fatalf("expected an error event, got %q", ev.Event)
		}
	default:
		t.Fatal("expected an error event, got nothing")
	}
}
