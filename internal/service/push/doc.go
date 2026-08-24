// Package push delivers Web Push notifications for chat messages a
// recipient didn't see over an open WebSocket.
//
// Web Push is entirely optional: it is off unless push.enabled is set and
// VAPID keys are configured. GET /api/v1/push/public-key returning 404 is
// the frontend's signal that push is unavailable, not a bug — see
// NewSender and Readme.md.
//
// Sender.Enqueue is called from the hub's event loop right after a message
// is broadcast over WebSocket and never blocks: it hands an Event to a
// worker pool, which resolves each recipient's effective notification
// level (types.NotificationStorage.ResolveNotificationTargets, mirroring
// the client's rules.ts) and either delivers immediately (a mention) or
// folds the message into a short per-(user,channel) aggregation window
// (see NOTIFICATIONS_PLAN.md §4.5) so a burst of ordinary messages
// collapses into one push instead of one per message. A subscription that
// the push service reports as gone (404/410) is deleted so it isn't
// retried.
package push
