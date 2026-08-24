package push

import (
	"fmt"
	"strings"

	"github.com/wlqoh/mini_discord.git/types"
)

const badgeIcon = "/favicon-192x192.png"

// PayloadData is the "data" field consumed by public/sw.js's notificationclick
// handler — keep the two in sync (NOTIFICATIONS_PLAN.md §4.6).
type PayloadData struct {
	ChannelID int64  `json:"channel_id"`
	ServerID  int64  `json:"server_id"`
	MessageID int64  `json:"message_id"`
	URL       string `json:"url"`
}

// Payload is the JSON body sent as the Web Push message; the browser's
// service worker (public/sw.js) renders it as a notification.
type Payload struct {
	Type     string      `json:"type"`
	Title    string      `json:"title"`
	Body     string      `json:"body"`
	Icon     string      `json:"icon,omitempty"`
	Badge    string      `json:"badge"`
	Tag      string      `json:"tag"`
	Renotify bool        `json:"renotify"`
	Data     PayloadData `json:"data"`
}

func resolveAuthorName(msg *types.WsMessage) string {
	nickname := strings.TrimSpace(msg.AuthorNickname)
	if nickname != "" {
		return nickname
	}
	fullName := strings.TrimSpace(strings.TrimSpace(msg.AuthorFirstName) + " " + strings.TrimSpace(msg.AuthorLastName))
	if fullName != "" {
		return fullName
	}
	return "Someone"
}

func resolveBody(msg *types.WsMessage) string {
	if msg.Content != "" {
		return msg.Content
	}
	if len(msg.Attachments) > 0 {
		return "📎 Attachment"
	}
	return "New message"
}

// buildPayload composes the push payload for one recipient. `count` is the
// number of messages folded into this send by the aggregation window — 1 for
// an immediate/mention send, >1 once several ordinary messages coalesced.
func buildPayload(event Event, kind string, count int, hidePreview bool) Payload {
	tag := fmt.Sprintf("channel-%d", event.ChannelID)
	data := PayloadData{
		ChannelID: event.ChannelID,
		ServerID:  event.ServerID,
		MessageID: event.Message.ID,
		URL:       fmt.Sprintf("/?channel=%d&message=%d", event.ChannelID, event.Message.ID),
	}

	if hidePreview {
		body := fmt.Sprintf("New message in #%s", event.ChannelName)
		if count > 1 {
			body = fmt.Sprintf("#%s: %d new messages", event.ChannelName, count)
		}
		return Payload{
			Type: kind, Title: "MuArAb", Body: body, Badge: badgeIcon, Tag: tag, Renotify: true, Data: data,
		}
	}

	if count > 1 {
		return Payload{
			Type:     "aggregate",
			Title:    fmt.Sprintf("#%s", event.ChannelName),
			Body:     fmt.Sprintf("%d new messages", count),
			Badge:    badgeIcon,
			Tag:      tag,
			Renotify: true,
			Data:     data,
		}
	}

	authorName := resolveAuthorName(event.Message)
	title := fmt.Sprintf("%s — #%s", authorName, event.ChannelName)
	if kind == "mention" {
		title = fmt.Sprintf("%s mentioned you in #%s", authorName, event.ChannelName)
	}

	return Payload{
		Type:     kind,
		Title:    title,
		Body:     resolveBody(event.Message),
		Icon:     event.Message.AuthorAvatarURL,
		Badge:    badgeIcon,
		Tag:      tag,
		Renotify: true,
		Data:     data,
	}
}
