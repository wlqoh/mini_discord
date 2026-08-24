// Package types is the single source of truth for the application's wire
// and storage contracts.
//
// It holds every WebSocket action/event name and payload struct
// (WsAction*, WsEvent*, and the Ws*Request/Ws*Response/Ws*Event types in
// websocket.go) that make up the real-time chat protocol between
// internal/service/server.Hub and the frontend. There is no codegen: any
// addition or rename here must be mirrored by hand in
// frontend/src/services/chatSocket.ts and frontend/src/types/chat.ts.
//
// It also declares the storage interfaces the rest of the backend depends
// on — ServerStorage, UserStorage, EmbedStorage, NotificationStorage,
// S3ClientStorage, PendingAttachmentStore — all implemented by
// internal/storage/postgresql.Storage (PendingAttachmentStore by
// internal/service/server.Hub instead, since it is in-memory). Keeping the
// interfaces here rather than in the storage package lets handler code
// depend only on the contract it needs without importing the concrete
// Postgres/S3 implementation.
package types
