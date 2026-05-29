const joinAudio = new Audio("/sounds/joinvoice.mp3");
joinAudio.volume = 0.6;

const leaveAudio = new Audio("/sounds/leavevoice.mp3");
leaveAudio.volume = 0.6;

export function playJoinSound(): void {
  joinAudio.pause();
  joinAudio.currentTime = 0;
  void joinAudio.play().catch(() => {});
}

export function playLeaveSound(): void {
  leaveAudio.pause();
  leaveAudio.currentTime = 0;
  void leaveAudio.play().catch(() => {});
}