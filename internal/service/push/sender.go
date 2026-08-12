package push

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/types"
)

const (
	eventBufferSize  = 1024
	workerCount      = 4
	aggregationDelay = 10 * time.Second
)

// Event is what the hub enqueues after broadcasting a message over WS — see
// hub.go's sendMessage. It carries everything the sender needs without
// having to re-query the hub (which must never block on this path).
type Event struct {
	RecipientIDs []int
	ChannelID    int64
	ServerID     int64
	ChannelName  string
	Message      *types.WsMessage
	IsMention    map[int]bool
	OnlineIDs    map[int]bool
}

type aggKey struct {
	userID    int
	channelID int64
}

type aggState struct {
	count       int
	last        Event
	hidePreview bool
	timer       *time.Timer
}

// Sender is a worker pool + per-(user,channel) aggregation window so a burst
// of ordinary messages collapses into one push, while a mention is delivered
// immediately. See NOTIFICATIONS_PLAN.md §4.5 for the full policy.
type Sender struct {
	storage types.NotificationStorage
	cfg     config.PushConfig
	log     *slog.Logger
	client  *http.Client

	events chan Event

	mu  sync.Mutex
	agg map[aggKey]*aggState
}

func NewSender(storage types.NotificationStorage, cfg config.PushConfig, log *slog.Logger) *Sender {
	s := &Sender{
		storage: storage,
		cfg:     cfg,
		log:     log,
		client:  &http.Client{Timeout: 10 * time.Second},
		events:  make(chan Event, eventBufferSize),
		agg:     make(map[aggKey]*aggState),
	}

	for i := 0; i < workerCount; i++ {
		go s.worker()
	}

	return s
}

// Enqueue is non-blocking: the hub goroutine must never wait on HTTP calls to
// push services. A full buffer drops the event — the unread counter still
// resyncs correctly on the recipient's next reconnect.
func (s *Sender) Enqueue(event Event) {
	if !s.cfg.Enabled {
		return
	}
	select {
	case s.events <- event:
	default:
		s.log.Warn("push event buffer full, dropping event", "channel_id", event.ChannelID)
	}
}

func (s *Sender) worker() {
	for event := range s.events {
		s.processEvent(event)
	}
}

func (s *Sender) processEvent(event Event) {
	ctx := context.Background()

	targets, err := s.storage.ResolveNotificationTargets(ctx, event.ChannelID, event.RecipientIDs)
	if err != nil {
		s.log.Error("failed to resolve notification targets", "error", err.Error())
		return
	}

	now := time.Now()
	for _, target := range targets {
		if event.OnlineIDs[target.UserID] {
			continue // the recipient's own tab already handled this over WS
		}
		if target.DNDUntil != nil && target.DNDUntil.After(now) {
			continue
		}
		if target.MutedUntil != nil && target.MutedUntil.After(now) {
			continue
		}
		if target.Level == types.NotificationLevelNone {
			continue
		}

		mention := event.IsMention[target.UserID]
		if target.Level == types.NotificationLevelMentions && !mention {
			continue
		}

		if mention {
			s.sendNow(target.UserID, event, "mention", target.HideMessagePreview)
		} else {
			s.aggregate(target.UserID, event, target.HideMessagePreview)
		}
	}
}

func (s *Sender) sendNow(userID int, event Event, kind string, hidePreview bool) {
	payload := buildPayload(event, kind, 1, hidePreview)
	urgency := webpush.UrgencyNormal
	if kind == "mention" {
		urgency = webpush.UrgencyHigh
	}
	s.deliver(userID, payload, urgency)
}

func (s *Sender) aggregate(userID int, event Event, hidePreview bool) {
	key := aggKey{userID: userID, channelID: event.ChannelID}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, exists := s.agg[key]
	if !exists {
		state = &aggState{}
		s.agg[key] = state
		state.timer = time.AfterFunc(aggregationDelay, func() { s.flushAggregate(key) })
	}
	state.count++
	state.last = event
	state.hidePreview = hidePreview
}

func (s *Sender) flushAggregate(key aggKey) {
	s.mu.Lock()
	state, exists := s.agg[key]
	if exists {
		delete(s.agg, key)
	}
	s.mu.Unlock()

	if !exists {
		return
	}

	payload := buildPayload(state.last, "message", state.count, state.hidePreview)
	s.deliver(key.userID, payload, webpush.UrgencyNormal)
}

func (s *Sender) deliver(userID int, payload Payload, urgency webpush.Urgency) {
	ctx := context.Background()

	subs, err := s.storage.ListPushSubscriptions(ctx, []int{userID})
	if err != nil {
		s.log.Error("failed to list push subscriptions", "user_id", userID, "error", err.Error())
		return
	}
	if len(subs) == 0 {
		return
	}

	body, err := json.Marshal(payload)
	if err != nil {
		s.log.Error("failed to marshal push payload", "error", err.Error())
		return
	}

	options := &webpush.Options{
		HTTPClient:      s.client,
		Subscriber:      s.cfg.Subject,
		TTL:             s.cfg.TTLSeconds,
		Urgency:         urgency,
		VAPIDPublicKey:  s.cfg.VAPIDPublic,
		VAPIDPrivateKey: s.cfg.VAPIDPrivate,
	}

	for _, sub := range subs {
		webpushSub := &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
		}

		resp, err := webpush.SendNotificationWithContext(ctx, body, webpushSub, options)
		if err != nil {
			s.log.Error("failed to send push notification", "endpoint", sub.Endpoint, "error", err.Error())
			continue
		}
		_ = resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			if err := s.storage.DeletePushSubscriptionByEndpoint(ctx, sub.Endpoint); err != nil {
				s.log.Error("failed to delete dead push subscription", "endpoint", sub.Endpoint, "error", err.Error())
			}
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			s.log.Info("push notification delivered", "user_id", userID, "status", resp.StatusCode, "type", payload.Type)
		} else {
			s.log.Warn("push service returned unexpected status", "endpoint", sub.Endpoint, "status", resp.StatusCode)
		}
	}
}
