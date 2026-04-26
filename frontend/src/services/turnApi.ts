import API from "../api";
import { extractApiError } from "./apiError";

export type TurnCredentialsResponse = {
  urls: string[];
  username: string;
  credential: string;
  ttl_seconds: number;
  expires_at: string;
};

export async function getTurnCredentials(): Promise<TurnCredentialsResponse> {
  try {
    const { data } = await API.get<TurnCredentialsResponse>("/webrtc/turn-credentials");
    return data;
  } catch (err) {
    throw new Error(extractApiError(err, "Failed to fetch TURN credentials"));
  }
}

