package types

type Attachment struct {
	ID          int64  `json:"id"`
	MessageID   int64  `json:"message_id"`
	FileKey     string `json:"-"`
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	URL          string `json:"url"`
	SizeBytes    int64  `json:"size_bytes"`
	CreatedAt    string `json:"created_at"`
}

type UploadResponse struct {
	AttachmentID int64  `json:"attachment_id"`
	URL          string `json:"url"`
}

type PendingAttachment struct {
	ID          int64  `json:"id"`
	UserID      int    `json:"user_id"`
	FolderKey   string `json:"folder_key"`
	FileKey     string `json:"file_key"`
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

type PendingAttachmentStore interface {
	StorePendingAttachment(pa PendingAttachment) int64
	TakePendingAttachment(id int64, userID int) (*PendingAttachment, bool)
}
