package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
)

const (
	videoPayloadType webrtc.PayloadType = 96
	audioPayloadType webrtc.PayloadType = 111
)

// newMediaEngine registers exactly what the SFU accepts (decision #5,
// sfu-migration-plan.md §3): VP8 + Opus, nothing else. Deliberately
// duplicated from internal/service/sfu/codecs.go rather than importing it —
// that package's registration is unexported, and this tool has no other
// reason to depend on the SFU implementation package.
func newMediaEngine() (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}

	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000},
		PayloadType:        videoPayloadType,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register VP8: %w", err)
	}

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

	return m, nil
}

// publishIVFLoop reads VP8 frames from an IVF file and writes them to track
// at the file's own pace, looping forever once EOF is reached — a load test
// is meant to run for a fixed wall-clock duration (see -duration), not for
// one playthrough of the sample file.
func publishIVFLoop(path string, track *webrtc.TrackLocalStaticSample, stop <-chan struct{}, onFrame func(n int)) error {
	for {
		if err := publishIVFOnce(path, track, stop, onFrame); err != nil {
			return err
		}
		select {
		case <-stop:
			return nil
		default:
		}
	}
}

func publishIVFOnce(path string, track *webrtc.TrackLocalStaticSample, stop <-chan struct{}, onFrame func(n int)) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer func() { _ = file.Close() }()

	reader, header, err := ivfreader.NewWith(file)
	if err != nil {
		return fmt.Errorf("parse IVF header: %w", err)
	}
	if header.FourCC != "VP80" {
		return fmt.Errorf("%s: unsupported FourCC %q (only VP80 IVF files are supported)", path, header.FourCC)
	}

	frameDuration := time.Second * time.Duration(header.TimebaseNumerator) / time.Duration(header.TimebaseDenominator)
	if frameDuration <= 0 {
		frameDuration = 33 * time.Millisecond // ~30fps fallback if the header's timebase is degenerate
	}

	ticker := time.NewTicker(frameDuration)
	defer ticker.Stop()

	for {
		frame, _, err := reader.ParseNextFrame()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read IVF frame: %w", err)
		}

		if err := track.WriteSample(media.Sample{Data: frame, Duration: frameDuration}); err != nil {
			return fmt.Errorf("write video sample: %w", err)
		}
		onFrame(len(frame))

		select {
		case <-ticker.C:
		case <-stop:
			return nil
		}
	}
}

// publishOggLoop reads Opus pages from an Ogg file and writes them to track,
// looping forever. Ogg/Opus in real-time streaming is conventionally paced
// in fixed 20ms pages regardless of the file's own page sizes — matches
// Pion's own play-from-disk example.
func publishOggLoop(path string, track *webrtc.TrackLocalStaticSample, stop <-chan struct{}, onFrame func(n int)) error {
	const pageDuration = 20 * time.Millisecond

	for {
		if err := publishOggOnce(path, track, stop, pageDuration, onFrame); err != nil {
			return err
		}
		select {
		case <-stop:
			return nil
		default:
		}
	}
}

func publishOggOnce(path string, track *webrtc.TrackLocalStaticSample, stop <-chan struct{}, pageDuration time.Duration, onFrame func(n int)) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer func() { _ = file.Close() }()

	reader, _, err := oggreader.NewWith(file)
	if err != nil {
		return fmt.Errorf("parse Ogg header: %w", err)
	}

	ticker := time.NewTicker(pageDuration)
	defer ticker.Stop()

	// The first page is the OpusHead/OpusTags metadata pair already consumed
	// by NewWith; skip forward is not needed, ParseNextPage continues from
	// the first real audio page.
	for {
		pageData, _, err := reader.ParseNextPage()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read Ogg page: %w", err)
		}

		if err := track.WriteSample(media.Sample{Data: pageData, Duration: pageDuration}); err != nil {
			return fmt.Errorf("write audio sample: %w", err)
		}
		onFrame(len(pageData))

		select {
		case <-ticker.C:
		case <-stop:
			return nil
		}
	}
}

func newLogger(prefix string) *log.Logger {
	return log.New(os.Stderr, prefix+" ", log.LstdFlags|log.Lmsgprefix)
}
