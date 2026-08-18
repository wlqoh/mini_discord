package sfu

import "testing"

func TestIsVP8Keyframe(t *testing.T) {
	tests := []struct {
		name    string
		payload []byte
		want    bool
	}{
		{
			name:    "empty payload",
			payload: []byte{},
			want:    false,
		},
		{
			name: "no X, start of partition 0, key frame",
			// 0x10 = X=0 R=0 N=0 S=1 R=0 PID=0
			// 0x00 = VP8 frame tag low byte, bit0=0 -> key frame
			payload: []byte{0x10, 0x00, 0xAA, 0xBB},
			want:    true,
		},
		{
			name: "no X, start of partition 0, interframe",
			// 0x01 = frame_tag bit0=1 -> interframe
			payload: []byte{0x10, 0x01, 0xAA, 0xBB},
			want:    false,
		},
		{
			name: "not start of partition",
			// S bit (0x10) not set
			payload: []byte{0x00, 0x00},
			want:    false,
		},
		{
			name: "start but wrong partition index",
			// S=1, PID=1 (not 0)
			payload: []byte{0x11, 0x00},
			want:    false,
		},
		{
			name: "X bit set, no extension flags, key frame",
			// 0x90 = X=1 S=1 PID=0; 0x00 = no I/L/T/K; 0x00 = key frame tag
			payload: []byte{0x90, 0x00, 0x00, 0xAA},
			want:    true,
		},
		{
			name: "X bit set with short (1-byte) PictureID, key frame",
			// 0x90 = X=1 S=1 PID=0; 0x80 = I=1; 0x05 = picture id (MSB=0 -> short form); 0x00 = key frame
			payload: []byte{0x90, 0x80, 0x05, 0x00, 0xAA},
			want:    true,
		},
		{
			name: "X bit set with long (2-byte) PictureID, interframe",
			// 0x90 = X=1 S=1 PID=0; 0x80 = I=1; 0x85 0x2A = 2-byte picture id (MSB=1 -> long form); 0x01 = interframe
			payload: []byte{0x90, 0x80, 0x85, 0x2A, 0x01, 0xAA},
			want:    false,
		},
		{
			name: "X bit set with TL0PICIDX and T/K byte, key frame",
			// 0x90 = X=1 S=1 PID=0; 0xC0 = L=1,T=1; 0x03 = TL0PICIDX; 0x20 = T/K byte; 0x00 = key frame
			payload: []byte{0x90, 0xC0, 0x03, 0x20, 0x00, 0xAA},
			want:    true,
		},
		{
			name:    "truncated after X bit",
			payload: []byte{0x90},
			want:    false,
		},
		{
			name: "truncated before frame tag byte",
			// X=1, I=1, short PictureID declared but payload ends right after it
			payload: []byte{0x90, 0x80, 0x05},
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isVP8Keyframe(tt.payload); got != tt.want {
				t.Errorf("isVP8Keyframe(%08b) = %v, want %v", tt.payload, got, tt.want)
			}
		})
	}
}
