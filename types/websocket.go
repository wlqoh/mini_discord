package types

type WsMessage struct {
	IPAddress string `json:"address"`
	Message   string `json:"message"`
	Time      string `json:"time"`
}
