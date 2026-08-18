package sfu

import (
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// TestPublishStateHidesSourceFromSnapshot covers decision #4: a source
// explicitly announced off via sfu_publish_state must not be offered to a
// peer that joins afterward, and must reappear once announced on again.
func TestPublishStateHidesSourceFromSnapshot(t *testing.T) {
	p := &Peer{
		userID:       7,
		published:    map[Source]*publishedTrack{SourceCamera: {kind: webrtc.RTPCodecTypeVideo}},
		publishState: map[Source]bool{},
	}

	// No sfu_publish_state received yet — defaults to active (see the
	// publishState field doc), same as a client that never announces.
	if infos := p.publishedVideoTrackInfos(); len(infos) != 1 || infos[0].Source != SourceCamera {
		t.Fatalf("expected camera in snapshot by default, got %+v", infos)
	}
	if !p.isSourceActive(SourceCamera) {
		t.Fatal("isSourceActive should default to true with no announcement")
	}

	p.setPublishState(SourceCamera, false)
	if got := p.publishedVideoTrackInfos(); len(got) != 0 {
		t.Fatalf("camera announced off should be excluded from the snapshot, got %+v", got)
	}
	if p.isSourceActive(SourceCamera) {
		t.Fatal("isSourceActive should reflect the off announcement")
	}

	p.setPublishState(SourceCamera, true)
	infos := p.publishedVideoTrackInfos()
	if len(infos) != 1 || infos[0].Source != SourceCamera {
		t.Fatalf("camera announced back on should reappear in the snapshot, got %+v", infos)
	}
	if !p.isSourceActive(SourceCamera) {
		t.Fatal("isSourceActive should reflect the on announcement")
	}
}

// recordingSignaler wraps stubSignaler to capture SendTrackPublishedTo
// calls — the per-user snapshot delivery this test exercises.
type recordingSignaler struct {
	stubSignaler

	mu     sync.Mutex
	events []snapshotEvent
}

type snapshotEvent struct {
	userID    int
	channelID int64
	info      TrackInfo
}

func (r *recordingSignaler) SendTrackPublishedTo(userID int, channelID int64, t TrackInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, snapshotEvent{userID: userID, channelID: channelID, info: t})
}

// TestSnapshotSentToJoiningPeer covers decision #3/defect 2: a peer that
// joins a room with already-published video must be told about it — audio
// is excluded (decision #8, auto-subscribed server-side instead).
func TestSnapshotSentToJoiningPeer(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	sig := &recordingSignaler{}

	router, err := New(Config{PublicIP: "127.0.0.1", UDPPort: 0}, sig, stubAuthorizer{}, log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() {
		if err := router.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	publisherSessionID, err := router.Join(1, 100)
	if err != nil {
		t.Fatalf("Join publisher: %v", err)
	}
	publisher, ok := router.peerBySession(publisherSessionID)
	if !ok {
		t.Fatal("publisher session not found after Join")
	}

	publisher.publishedMu.Lock()
	publisher.published[SourceCamera] = &publishedTrack{kind: webrtc.RTPCodecTypeVideo}
	publisher.published[SourceScreen] = &publishedTrack{kind: webrtc.RTPCodecTypeVideo}
	publisher.published[SourceMic] = &publishedTrack{kind: webrtc.RTPCodecTypeAudio}
	publisher.publishedMu.Unlock()

	joinerSessionID, err := router.Join(2, 100)
	if err != nil {
		t.Fatalf("Join joiner: %v", err)
	}
	joiner, ok := router.peerBySession(joinerSessionID)
	if !ok {
		t.Fatal("joiner session not found after Join")
	}

	joiner.sendTrackSnapshot()

	sig.mu.Lock()
	defer sig.mu.Unlock()
	if len(sig.events) != 2 {
		t.Fatalf("expected exactly 2 snapshot events (camera+screen, no audio), got %d: %+v", len(sig.events), sig.events)
	}
	seen := map[Source]bool{}
	for _, e := range sig.events {
		if e.userID != 2 || e.channelID != 100 {
			t.Fatalf("snapshot event addressed to the wrong peer/channel: %+v", e)
		}
		if e.info.UserID != 1 {
			t.Fatalf("snapshot event should describe the publisher, got %+v", e)
		}
		seen[e.info.Source] = true
	}
	if !seen[SourceCamera] || !seen[SourceScreen] {
		t.Fatalf("expected both camera and screen in the snapshot, got %+v", sig.events)
	}
}

// TestPublishStateActiveRequestsKeyframe covers decision #5/defect 4: when a
// source's sfu_publish_state flips back to active, an already-subscribed
// viewer must get a fresh PLI instead of waiting out the publisher's own
// keyframe interval. Needs a real, connected PeerConnection pair — PLI only
// means anything once there's an actual SSRC and transport to send it over.
func TestPublishStateActiveRequestsKeyframe(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	serverAPI, closeServerUDP, err := newAPI(Config{PublicIP: "127.0.0.1", UDPPort: 0})
	if err != nil {
		t.Fatalf("newAPI server: %v", err)
	}
	defer func() { _ = closeServerUDP() }()

	clientAPI, closeClientUDP, err := newAPI(Config{PublicIP: "127.0.0.1", UDPPort: 0})
	if err != nil {
		t.Fatalf("newAPI client: %v", err)
	}
	defer func() { _ = closeClientUDP() }()

	serverPC, err := serverAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("server NewPeerConnection: %v", err)
	}
	defer func() { _ = serverPC.Close() }()

	clientPC, err := clientAPI.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client NewPeerConnection: %v", err)
	}
	defer func() { _ = clientPC.Close() }()

	serverPC.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		_ = clientPC.AddICECandidate(c.ToJSON())
	})
	clientPC.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		_ = serverPC.AddICECandidate(c.ToJSON())
	})

	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		"video", "pion",
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticSample: %v", err)
	}
	sender, err := clientPC.AddTrack(videoTrack)
	if err != nil {
		t.Fatalf("AddTrack: %v", err)
	}

	// Only pub.addLayer below may ever call remote.ReadRTP() — TrackRemote
	// isn't safe for concurrent reads by a second goroutine, and forwardLayer
	// (started by addLayer) is already the real drain path.
	trackCh := make(chan *webrtc.TrackRemote, 1)
	serverPC.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		select {
		case trackCh <- remote:
		default:
		}
	})

	offer, err := clientPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	if err := clientPC.SetLocalDescription(offer); err != nil {
		t.Fatalf("client SetLocalDescription: %v", err)
	}
	if err := serverPC.SetRemoteDescription(offer); err != nil {
		t.Fatalf("server SetRemoteDescription: %v", err)
	}
	answer, err := serverPC.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("CreateAnswer: %v", err)
	}
	if err := serverPC.SetLocalDescription(answer); err != nil {
		t.Fatalf("server SetLocalDescription: %v", err)
	}
	if err := clientPC.SetRemoteDescription(answer); err != nil {
		t.Fatalf("client SetRemoteDescription: %v", err)
	}

	// The server only learns the track's SSRC once it actually sees a
	// packet — keep feeding samples until OnTrack fires or we give up.
	stopSending := make(chan struct{})
	defer close(stopSending)
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		payload := []byte{0x10, 0x00, 0xAA, 0xBB} // VP8 keyframe-shaped payload
		for {
			select {
			case <-ticker.C:
				_ = videoTrack.WriteSample(media.Sample{Data: payload, Duration: 33 * time.Millisecond})
			case <-stopSending:
				return
			}
		}
	}()

	var remote *webrtc.TrackRemote
	select {
	case remote = <-trackCh:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for OnTrack on the server side")
	}

	pliCh := make(chan struct{}, 1)
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, err := sender.Read(buf)
			if err != nil {
				return
			}
			packets, err := rtcp.Unmarshal(buf[:n])
			if err != nil {
				continue
			}
			for _, pkt := range packets {
				if _, ok := pkt.(*rtcp.PictureLossIndication); ok {
					select {
					case pliCh <- struct{}{}:
					default:
					}
				}
			}
		}
	}()

	owner := &Peer{
		pc:           serverPC,
		log:          log,
		published:    map[Source]*publishedTrack{},
		publishState: map[Source]bool{SourceCamera: false},
	}
	pub := newPublishedTrack(1, SourceCamera, webrtc.RTPCodecTypeVideo, owner, 0)
	pub.addLayer(remote, log)
	owner.published[SourceCamera] = pub

	owner.setPublishState(SourceCamera, true)

	select {
	case <-pliCh:
	case <-time.After(10 * time.Second):
		t.Fatal("expected a PLI to be sent to the publisher when the source resumes")
	}
}
