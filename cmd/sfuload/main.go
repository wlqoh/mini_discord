// Command sfuload is a headless load-test client for the SFU voice
// transport (sfu-migration-plan.md §7 phase 4, decision #13). It simulates
// N real browser clients joining one voice channel, each publishing a
// looping mic/camera recording and (by default) subscribing to everyone
// else's video — the scenario manual two-browser testing can't reach, and
// the evidence §9 of that plan specifies for validating SFU under a
// realistic room size.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	var (
		serverURL  = flag.String("server", "", "Base WebSocket origin, e.g. wss://hyorward.tech (required)")
		channelID  = flag.Int64("channel", 0, "Voice channel ID to join — must resolve to transport_mode=sfu (required)")
		tokensFlag = flag.String("tokens", "", "Comma-separated JWTs, one per simulated bot")
		tokensFile = flag.String("tokens-file", "", "Path to a file with one JWT per line (alternative/addition to -tokens)")
		videoPath  = flag.String("video", "", "Path to a VP8 .ivf file to loop-publish as each bot's camera (optional)")
		audioPath  = flag.String("audio", "", "Path to an Opus .ogg file to loop-publish as each bot's mic (optional)")
		duration   = flag.Duration("duration", 60*time.Second, "How long to run before disconnecting and printing the report")
		subscribe  = flag.Bool("subscribe", true, "Subscribe to every other participant's published camera video")
		stagger    = flag.Duration("stagger", 200*time.Millisecond, "Delay between starting each bot, to avoid a join thundering herd")
	)
	flag.Usage = func() {
		fmt.Fprint(os.Stderr, `sfuload — headless SFU load test client (sfu-migration-plan.md §7 phase 4)

Each simulated participant needs its OWN real user account and JWT: an SFU
session is tied 1:1 to a user_id, and the server ends a user's existing
voice session the instant they "join" again (see hub.go's
leaveVoiceChannelInternal called from joinVoiceChannel) — reusing one token
for N bots would just make one user join/leave N times in a row, not
simulate N concurrent people. Register N test accounts through the normal
signup flow, add them all to the server that owns the target channel, and
collect each account's access token (e.g. the "token" key in that account's
browser localStorage after logging in) into a file, one per line, for
-tokens-file.

Sample media: generate with ffmpeg —
  ffmpeg -i input.mp4 -an -c:v libvpx -b:v 1M sample.ivf
  ffmpeg -i input.mp4 -vn -c:a libopus -page_duration 20000 sample.ogg

Usage:
  sfuload -server wss://hyorward.tech -channel 42 -tokens-file bots.txt \
    -video sample.ivf -audio sample.ogg -duration 2m

Flags:
`)
		flag.PrintDefaults()
	}
	flag.Parse()

	if *serverURL == "" || *channelID == 0 {
		flag.Usage()
		os.Exit(2)
	}

	tokens, err := loadTokens(*tokensFlag, *tokensFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	if len(tokens) == 0 {
		fmt.Fprintln(os.Stderr, "error: no tokens provided (-tokens or -tokens-file) — see -h")
		os.Exit(1)
	}

	wsURL := strings.TrimSuffix(*serverURL, "/") + "/api/v1/server/ws"
	fmt.Printf("sfuload: starting %d bot(s) against %s (channel %d, duration %s)\n", len(tokens), wsURL, *channelID, *duration)

	stop := make(chan struct{})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	bots := make([]*bot, len(tokens))
	runErrs := make([]error, len(tokens))
	var wg sync.WaitGroup

	for i, token := range tokens {
		b := newBot(i+1, token, wsURL, *channelID, *videoPath, *audioPath, *subscribe)
		bots[i] = b
		wg.Add(1)
		go func(i int, b *bot) {
			defer wg.Done()
			if err := b.run(stop); err != nil {
				runErrs[i] = err
				b.log.Printf("error: %v", err)
			}
		}(i, b)
		time.Sleep(*stagger)
	}

	timer := time.NewTimer(*duration)
	select {
	case <-timer.C:
		fmt.Printf("\nsfuload: %s elapsed, stopping...\n", *duration)
	case <-sigCh:
		timer.Stop()
		fmt.Println("\nsfuload: interrupted, stopping...")
	}
	close(stop)

	waitCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(waitCh)
	}()
	select {
	case <-waitCh:
	case <-time.After(10 * time.Second):
		fmt.Println("sfuload: timed out waiting for bots to disconnect cleanly")
	}

	printReport(bots, runErrs)
}

func loadTokens(tokensFlag, tokensFile string) ([]string, error) {
	var tokens []string

	if tokensFlag != "" {
		for _, t := range strings.Split(tokensFlag, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				tokens = append(tokens, t)
			}
		}
	}

	if tokensFile != "" {
		f, err := os.Open(tokensFile)
		if err != nil {
			return nil, fmt.Errorf("open tokens file: %w", err)
		}
		defer func() { _ = f.Close() }()

		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line != "" && !strings.HasPrefix(line, "#") {
				tokens = append(tokens, line)
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("read tokens file: %w", err)
		}
	}

	return tokens, nil
}

func printReport(bots []*bot, runErrs []error) {
	fmt.Println()
	fmt.Println("==================== sfuload report ====================")

	var joined, iceFailed int
	var totalVideoFrames, totalVideoBytes, totalAudioFrames, totalAudioBytes int64
	var totalPacketsReceived, totalBytesReceived, totalPacketsLost int64
	var totalTracksReceived int32

	for _, b := range bots {
		if b.stats.joined.Load() {
			joined++
		}
		if b.stats.iceFailed.Load() {
			iceFailed++
		}
		totalVideoFrames += b.stats.videoFramesSent.Load()
		totalVideoBytes += b.stats.videoBytesSent.Load()
		totalAudioFrames += b.stats.audioFramesSent.Load()
		totalAudioBytes += b.stats.audioBytesSent.Load()
		totalPacketsReceived += b.stats.packetsReceived.Load()
		totalBytesReceived += b.stats.bytesReceived.Load()
		totalPacketsLost += b.stats.packetsLost.Load()
		totalTracksReceived += b.stats.tracksReceived.Load()
	}

	fmt.Printf("bots:              %d\n", len(bots))
	fmt.Printf("joined SFU:        %d\n", joined)
	fmt.Printf("ICE failed:        %d\n", iceFailed)
	fmt.Printf("video frames sent: %d (%.1f MB)\n", totalVideoFrames, float64(totalVideoBytes)/1e6)
	fmt.Printf("audio frames sent: %d (%.1f MB)\n", totalAudioFrames, float64(totalAudioBytes)/1e6)
	fmt.Printf("tracks received:   %d\n", totalTracksReceived)
	fmt.Printf("packets received:  %d (%.1f MB)\n", totalPacketsReceived, float64(totalBytesReceived)/1e6)

	lossPct := 0.0
	if totalPacketsReceived+totalPacketsLost > 0 {
		lossPct = 100 * float64(totalPacketsLost) / float64(totalPacketsReceived+totalPacketsLost)
	}
	fmt.Printf("estimated loss:    %d packets (%.2f%%, sequence-gap heuristic)\n", totalPacketsLost, lossPct)

	var allErrors []string
	for i, err := range runErrs {
		if err != nil {
			allErrors = append(allErrors, fmt.Sprintf("bot-%02d: fatal: %v", i+1, err))
		}
	}
	for i, b := range bots {
		for _, e := range b.stats.errorList() {
			allErrors = append(allErrors, fmt.Sprintf("bot-%02d: %s", i+1, e))
		}
	}
	fmt.Printf("errors:            %d\n", len(allErrors))
	for _, e := range allErrors {
		fmt.Println("  -", e)
	}
	fmt.Println("==========================================================")
}
