package sfu

import (
	"fmt"
	"net"

	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

const (
	videoPayloadType webrtc.PayloadType = 96
	audioPayloadType webrtc.PayloadType = 111
)

// newMediaEngine registers exactly VP8 and Opus — decision #5
// (sfu-migration-plan.md §3): a single mandatory codec pair, no fallback.
// The SFU forwards RTP payloads as-is without transcoding, so every
// publisher and subscriber in a room must speak the same codec; adding a
// second one would mean every peer in the router needs to negotiate and
// track which codec each other peer uses.
func newMediaEngine() (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}

	videoFeedback := []webrtc.RTCPFeedback{
		{Type: webrtc.TypeRTCPFBGoogREMB},
		{Type: webrtc.TypeRTCPFBCCM, Parameter: "fir"},
		{Type: webrtc.TypeRTCPFBNACK},
		{Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"},
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeVP8,
			ClockRate:    90000,
			RTCPFeedback: videoFeedback,
		},
		PayloadType: videoPayloadType,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register VP8: %w", err)
	}

	// useinbandfec+usedtx (decision #5): DTX means a silent publisher's mic
	// track produces almost no RTP packets, which the SFU would otherwise
	// re-forward to every subscriber — this is where DTX actually pays off
	// under an SFU, unlike in the old mesh where each link was 1:1 anyway.
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1;usedtx=1",
		},
		PayloadType: audioPayloadType,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register Opus: %w", err)
	}

	headerExtensions := []struct {
		uri string
		typ webrtc.RTPCodecType
	}{
		// Unused until migration phase 3 (active speaker detection,
		// sfu-migration-plan.md §3 decision #9) but registered now so the
		// SDP contract doesn't change once that phase reads it.
		{uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level", typ: webrtc.RTPCodecTypeAudio},
		{uri: "urn:ietf:params:rtp-hdrext:sdes:mid", typ: webrtc.RTPCodecTypeAudio},
		{uri: "urn:ietf:params:rtp-hdrext:sdes:mid", typ: webrtc.RTPCodecTypeVideo},
		// Unused until migration phase 6 (simulcast, decision #4).
		{uri: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id", typ: webrtc.RTPCodecTypeVideo},
		{uri: "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id", typ: webrtc.RTPCodecTypeVideo},
	}
	for _, ext := range headerExtensions {
		if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: ext.uri}, ext.typ); err != nil {
			return nil, fmt.Errorf("register header extension %s: %w", ext.uri, err)
		}
	}

	return m, nil
}

// newAPI builds the single webrtc.API every peer connection in the router is
// created from, and the UDP socket every one of them multiplexes over (one
// process-wide port — sfu-migration-plan.md §3 decision #7 — avoids a
// docker-proxy per port, which a real port range would need). The returned
// closer must be called on Router.Close.
func newAPI(cfg Config) (api *webrtc.API, closeUDP func() error, err error) {
	mediaEngine, err := newMediaEngine()
	if err != nil {
		return nil, nil, err
	}

	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, nil, fmt.Errorf("register interceptors: %w", err)
	}

	udpConn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: cfg.UDPPort})
	if err != nil {
		return nil, nil, fmt.Errorf("listen udp :%d: %w", cfg.UDPPort, err)
	}

	settingEngine := webrtc.SettingEngine{}
	logger := logging.NewDefaultLoggerFactory().NewLogger("sfu-ice")
	settingEngine.SetICEUDPMux(webrtc.NewICEUDPMux(logger, udpConn))
	if cfg.PublicIP != "" {
		// Required in Docker: without it Pion advertises host ICE candidates
		// with the container's internal address and ICE never connects for
		// anyone — sfu-migration-plan.md §8 pitfall #1.
		//
		// SA1019: SetNAT1To1IPs устарел в пользу SetICEAddressRewriteRules, но
		// миграция меняет объявляемые ICE-кандидаты и проверяется только живым
		// звонком через TURN, а не go test. Вынесено в отдельную задачу; см.
		// tmp/CI_PLAN.md §7.2.
		//nolint:staticcheck // см. комментарий выше
		settingEngine.SetNAT1To1IPs([]string{cfg.PublicIP}, webrtc.ICECandidateTypeHost)
	}

	api = webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settingEngine),
	)
	return api, udpConn.Close, nil
}
