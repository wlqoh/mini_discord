package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/wlqoh/mini_discord.git/internal/service/sfu"
	"github.com/wlqoh/mini_discord.git/types"
)

const (
	joinTimeout   = 10 * time.Second
	answerTimeout = 10 * time.Second
)

// botStats accumulates everything the final report needs. Counters are
// atomic because RTP handling (OnTrack) and the publish loops write to them
// from their own goroutines, independent of the bot's main flow.
type botStats struct {
	videoFramesSent atomic.Int64
	videoBytesSent  atomic.Int64
	audioFramesSent atomic.Int64
	audioBytesSent  atomic.Int64

	packetsReceived atomic.Int64
	bytesReceived   atomic.Int64
	packetsLost     atomic.Int64
	tracksReceived  atomic.Int32

	joined    atomic.Bool
	iceFailed atomic.Bool

	transportMode string // set once before any concurrent access begins

	mu     sync.Mutex
	errors []string
}

func (s *botStats) addError(format string, args ...any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.errors = append(s.errors, fmt.Sprintf(format, args...))
}

func (s *botStats) errorList() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.errors))
	copy(out, s.errors)
	return out
}

// bot drives one simulated SFU participant: connects, joins the target
// voice channel, publishes a looping mic/camera recording, and (if
// subscribe is set) subscribes to every other participant's video —
// exercising the same fan-out path a room full of real browsers would
// (sfu-migration-plan.md §7 phase 4).
//
// Concurrency: pc, sessionID, remoteDescSet, pendingCandidates, and
// knownPublishers are only ever touched from wsClient's single readLoop
// goroutine (handleEvent runs there, synchronously, one message at a time —
// see wsclient.go) or from run()'s own goroutine strictly before the first
// event for this session can arrive. Unlike internal/service/sfu's Peer,
// nothing here needs its own lock beyond that ordering guarantee.
type bot struct {
	index     int
	token     string
	serverURL string
	channelID int64
	videoPath string
	audioPath string
	subscribe bool

	log   *log.Logger
	stats botStats

	pc                *webrtc.PeerConnection
	sessionID         string
	remoteDescSet     bool
	pendingCandidates []webrtc.ICECandidateInit
	answerCh          chan string // signaled once by the sfu_answer event answering our initial offer
	knownPublishers   map[int]bool
}

func newBot(index int, token, serverURL string, channelID int64, videoPath, audioPath string, subscribe bool) *bot {
	return &bot{
		index:           index,
		token:           token,
		serverURL:       serverURL,
		channelID:       channelID,
		videoPath:       videoPath,
		audioPath:       audioPath,
		subscribe:       subscribe,
		log:             newLogger(fmt.Sprintf("[bot-%02d]", index)),
		answerCh:        make(chan string, 1),
		knownPublishers: make(map[int]bool),
	}
}

func (b *bot) run(stop <-chan struct{}) error {
	api, err := newAPIForBot()
	if err != nil {
		return fmt.Errorf("build webrtc API: %w", err)
	}

	url := fmt.Sprintf("%s?token=%s", b.serverURL, b.token)
	// dialWSClient starts reading immediately; onEvent is nil until set just
	// below (readLoop guards against that — see wsclient.go), so no event
	// arriving in that narrow window is silently dropped, which is fine:
	// nothing meaningful can arrive before join_voice_channel completes.
	client, err := dialWSClient(url, nil)
	if err != nil {
		return fmt.Errorf("connect websocket: %w", err)
	}
	defer client.Close()
	client.onEvent = func(event string, data json.RawMessage) {
		b.handleEvent(client, event, data)
	}

	ackData, err := client.sendCommand(types.WsActionJoinVoiceChannel, types.WsJoinVoiceChannelRequest{ChannelID: b.channelID}, joinTimeout)
	if err != nil {
		return fmt.Errorf("join_voice_channel: %w", err)
	}

	var joinResp types.WsJoinVoiceChannelResponse
	if err := json.Unmarshal(ackData, &joinResp); err != nil {
		return fmt.Errorf("parse join_voice_channel ack: %w", err)
	}
	b.stats.transportMode = joinResp.TransportMode
	if joinResp.TransportMode != types.TransportModeSFU {
		return fmt.Errorf("channel %d is not on the SFU transport (transport_mode=%q) — check SFU_ENABLED/SFU_CHANNEL_ALLOWLIST", b.channelID, joinResp.TransportMode)
	}
	if joinResp.SessionID == "" {
		return fmt.Errorf("join_voice_channel ack missing session_id")
	}
	b.sessionID = joinResp.SessionID
	b.stats.joined.Store(true)
	b.log.Printf("joined channel %d as session %s (%d existing participants)", b.channelID, b.sessionID, len(joinResp.Participants))

	iceServers := make([]webrtc.ICEServer, 0, len(joinResp.ICEServers))
	for _, s := range joinResp.ICEServers {
		iceServers = append(iceServers, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}

	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		return fmt.Errorf("create peer connection: %w", err)
	}
	b.pc = pc
	defer func() { _ = pc.Close() }()

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		b.log.Printf("ice state: %s", state)
		if state == webrtc.ICEConnectionStateFailed {
			b.stats.iceFailed.Store(true)
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		payload := types.WsSfuCandidatePayload{
			SessionID:     b.sessionID,
			Candidate:     init.Candidate,
			SDPMid:        init.SDPMid,
			SDPMLineIndex: init.SDPMLineIndex,
		}
		if err := client.sendFireAndForget(types.WsActionSfuCandidate, payload); err != nil {
			b.stats.addError("send candidate: %v", err)
		}
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		b.stats.tracksReceived.Add(1)
		b.log.Printf("receiving track: kind=%s id=%s", remote.Kind(), remote.ID())
		go b.readRemoteTrack(remote)
	})

	slotDecls := make([]types.WsSfuSlotDecl, 0, len(sfu.PublishSlots))
	for _, slot := range sfu.PublishSlots {
		kind := webrtc.RTPCodecTypeAudio
		if slot.Kind == "video" {
			kind = webrtc.RTPCodecTypeVideo
		}
		transceiver, err := pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			return fmt.Errorf("add transceiver for %s: %w", slot.Source, err)
		}

		switch slot.Source {
		case sfu.SourceMic:
			if b.audioPath != "" {
				track, err := webrtc.NewTrackLocalStaticSample(
					webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
					"audio", fmt.Sprintf("bot%d", b.index),
				)
				if err != nil {
					return fmt.Errorf("create audio track: %w", err)
				}
				if err := transceiver.Sender().ReplaceTrack(track); err != nil {
					return fmt.Errorf("attach audio track: %w", err)
				}
				go func() {
					if err := publishOggLoop(b.audioPath, track, stop, func(n int) {
						b.stats.audioFramesSent.Add(1)
						b.stats.audioBytesSent.Add(int64(n))
					}); err != nil {
						b.stats.addError("publish audio: %v", err)
					}
				}()
			}
		case sfu.SourceCamera:
			if b.videoPath != "" {
				track, err := webrtc.NewTrackLocalStaticSample(
					webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
					"video", fmt.Sprintf("bot%d", b.index),
				)
				if err != nil {
					return fmt.Errorf("create video track: %w", err)
				}
				if err := transceiver.Sender().ReplaceTrack(track); err != nil {
					return fmt.Errorf("attach video track: %w", err)
				}
				go func() {
					if err := publishIVFLoop(b.videoPath, track, stop, func(n int) {
						b.stats.videoFramesSent.Add(1)
						b.stats.videoBytesSent.Add(int64(n))
					}); err != nil {
						b.stats.addError("publish video: %v", err)
					}
				}()
			}
		}
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}

	for i, transceiver := range pc.GetTransceivers() {
		if i >= len(sfu.PublishSlots) {
			break
		}
		slotDecls = append(slotDecls, types.WsSfuSlotDecl{
			MID:    transceiver.Mid(),
			Kind:   sfu.PublishSlots[i].Kind,
			Source: string(sfu.PublishSlots[i].Source),
		})
	}

	if _, err := client.sendCommand(types.WsActionSfuOffer, types.WsSfuOfferRequest{
		SessionID: b.sessionID,
		SDP:       offer.SDP,
		Slots:     slotDecls,
	}, answerTimeout); err != nil {
		return fmt.Errorf("sfu_offer: %w", err)
	}

	select {
	case answerSDP := <-b.answerCh:
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answerSDP}); err != nil {
			return fmt.Errorf("set remote description (answer): %w", err)
		}
		b.remoteDescSet = true
		b.flushPendingCandidates()
	case <-time.After(answerTimeout):
		return fmt.Errorf("timed out waiting for sfu_answer")
	case <-stop:
		return nil
	}

	b.log.Printf("negotiated, publishing (%s)", describeMedia(b.videoPath, b.audioPath))

	<-stop

	_, _ = client.sendCommand(types.WsActionLeaveVoiceChannel, struct{}{}, 3*time.Second)
	return nil
}

// handleEvent processes every server-pushed event for this bot's session.
// Always called from wsClient's single readLoop goroutine — see the
// concurrency note on the bot struct.
func (b *bot) handleEvent(client *wsClient, event string, data json.RawMessage) {
	switch event {
	case types.WsEventSfuAnswer:
		var payload types.WsSfuAnswerPayload
		if err := json.Unmarshal(data, &payload); err != nil || payload.SessionID != b.sessionID {
			return
		}
		select {
		case b.answerCh <- payload.SDP:
		default:
		}

	case types.WsEventSfuOffer:
		var payload types.WsSfuOfferEvent
		if err := json.Unmarshal(data, &payload); err != nil || payload.SessionID != b.sessionID || b.pc == nil {
			return
		}
		if err := b.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: payload.SDP}); err != nil {
			b.stats.addError("set remote description (server offer): %v", err)
			return
		}
		b.remoteDescSet = true
		b.flushPendingCandidates()

		answer, err := b.pc.CreateAnswer(nil)
		if err != nil {
			b.stats.addError("create answer: %v", err)
			return
		}
		if err := b.pc.SetLocalDescription(answer); err != nil {
			b.stats.addError("set local description (answer): %v", err)
			return
		}
		if _, err := client.sendCommand(types.WsActionSfuAnswer, types.WsSfuAnswerPayload{SessionID: b.sessionID, SDP: answer.SDP}, answerTimeout); err != nil {
			b.stats.addError("sfu_answer: %v", err)
		}

	case types.WsEventSfuCandidate:
		var payload types.WsSfuCandidatePayload
		if err := json.Unmarshal(data, &payload); err != nil || payload.SessionID != b.sessionID || b.pc == nil {
			return
		}
		init := webrtc.ICECandidateInit{Candidate: payload.Candidate, SDPMid: payload.SDPMid, SDPMLineIndex: payload.SDPMLineIndex}
		if !b.remoteDescSet {
			b.pendingCandidates = append(b.pendingCandidates, init)
			return
		}
		if err := b.pc.AddICECandidate(init); err != nil {
			b.stats.addError("add ice candidate: %v", err)
		}

	case types.WsEventSfuTrackPublished:
		if !b.subscribe {
			return
		}
		var payload types.WsSfuTrackEvent
		if err := json.Unmarshal(data, &payload); err != nil {
			return
		}
		if payload.Kind != "video" || b.knownPublishers[payload.UserID] {
			return
		}
		b.knownPublishers[payload.UserID] = true
		go func() {
			if _, err := client.sendCommand(types.WsActionSfuSubscribeVideo, types.WsSfuSubscribeVideoRequest{
				SessionID:    b.sessionID,
				TargetUserID: payload.UserID,
				Source:       payload.Source,
				Quality:      "high",
			}, answerTimeout); err != nil {
				b.stats.addError("subscribe_video(user=%d): %v", payload.UserID, err)
			}
		}()

	case types.WsEventSfuError:
		var payload types.WsSfuErrorEvent
		if err := json.Unmarshal(data, &payload); err == nil {
			b.stats.addError("sfu_error: %s: %s", payload.Code, payload.Message)
		}
	}
}

func (b *bot) flushPendingCandidates() {
	pending := b.pendingCandidates
	b.pendingCandidates = nil
	for _, c := range pending {
		if err := b.pc.AddICECandidate(c); err != nil {
			b.stats.addError("add pending ice candidate: %v", err)
		}
	}
}

// readRemoteTrack drains one subscribed track for the lifetime of the
// session, counting packets/bytes and estimating loss from sequence-number
// gaps. Doesn't decode anything (sfu-migration-plan.md §7 phase 4) — the
// point is to prove RTP arrives under load, not to render it. The loss
// estimate is a heuristic: a genuinely reordered (not lost) packet is
// indistinguishable from loss by sequence number alone, and this doesn't
// correct for it — good enough for "does the fan-out survive N publishers",
// not for a real QoS report.
func (b *bot) readRemoteTrack(remote *webrtc.TrackRemote) {
	var lastSeq uint16
	haveLastSeq := false

	for {
		packet, _, err := remote.ReadRTP()
		if err != nil {
			return
		}
		b.stats.packetsReceived.Add(1)
		b.stats.bytesReceived.Add(int64(len(packet.Payload)))

		if haveLastSeq {
			gap := packet.SequenceNumber - lastSeq // uint16 wraparound-safe
			if gap > 1 {
				b.stats.packetsLost.Add(int64(gap - 1))
			}
		}
		lastSeq = packet.SequenceNumber
		haveLastSeq = true
	}
}

func describeMedia(videoPath, audioPath string) string {
	switch {
	case videoPath != "" && audioPath != "":
		return "audio+video"
	case audioPath != "":
		return "audio only"
	case videoPath != "":
		return "video only"
	default:
		return "no media (subscribe-only)"
	}
}

func newAPIForBot() (*webrtc.API, error) {
	m, err := newMediaEngine()
	if err != nil {
		return nil, err
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m)), nil
}
