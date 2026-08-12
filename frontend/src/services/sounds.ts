import { playSound } from "./notifications/sound.ts";

export function playJoinSound(): void {
  playSound("join");
}

export function playLeaveSound(): void {
  playSound("leave");
}
