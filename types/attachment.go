package types

// Attachment is a file attached to a message, already persisted to S3 and
// linked to a message row.
type Attachment struct {
	ID          int64  `json:"id"`
	MessageID   int64  `json:"message_id"`
	FileKey     string `json:"-"` // S3 object key; never serialized, URL is derived from it
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	URL         string `json:"url"`
	SizeBytes   int64  `json:"size_bytes"`
	CreatedAt   string `json:"created_at"`
}

// UploadResponse is the REST response for POST /upload: the file has been
// stored as a PendingAttachment, not yet attached to any message.
type UploadResponse struct {
	AttachmentID int64  `json:"attachment_id"`
	URL          string `json:"url"`
}

// PendingAttachment is a file uploaded over REST but not yet attached to a
// message. The hub holds it in memory, keyed by ID, until a send_message
// command references it via attachment_ids (see PendingAttachmentStore).
type PendingAttachment struct {
	ID          int64  `json:"id"`
	UserID      int    `json:"user_id"`
	FolderKey   string `json:"folder_key"`
	FileKey     string `json:"file_key"`
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

// PendingAttachmentStore is the hub's in-memory holding area for uploaded
// files between POST /upload and the send_message command that consumes
// them.
type PendingAttachmentStore interface {
	// StorePendingAttachment records pa and returns the ID it was assigned.
	StorePendingAttachment(pa PendingAttachment) int64
	// TakePendingAttachment removes and returns the pending attachment with
	// the given ID, provided it belongs to userID. It is one-shot: a
	// successful call deletes the entry, so the same upload cannot be
	// attached to a second message. If id is unknown or owned by a
	// different user, it returns (nil, false) and leaves the store
	// untouched.
	TakePendingAttachment(id int64, userID int) (*PendingAttachment, bool)
}
