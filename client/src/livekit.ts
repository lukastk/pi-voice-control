import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteParticipant,
} from "livekit-client";
import type { DispatchResult } from "./api.ts";

export type VoiceState = "idle" | "connecting" | "connected" | "error";

export type DataMessage = {
  kind: "error" | "info";
  source?: string;
  message: string;
};

export type VoiceHandle = {
  room: Room;
  audioElement: HTMLAudioElement;
  disconnect: () => Promise<void>;
};

export async function connectVoice(
  d: DispatchResult,
  log: (msg: string) => void,
  opts: { startMicEnabled: boolean; onMessage?: (msg: DataMessage) => void },
): Promise<VoiceHandle> {
  const room = new Room({
    audioCaptureDefaults: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const audioElement = document.createElement("audio");
  audioElement.autoplay = true;
  audioElement.style.display = "none";
  document.body.appendChild(audioElement);

  room
    .on(RoomEvent.Connected, () => log("connected"))
    .on(RoomEvent.Disconnected, (reason) => log(`disconnected: ${reason ?? "unknown"}`))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => log(`participant: ${p.identity}`))
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        track.attach(audioElement);
      }
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
    })
    .on(RoomEvent.DataReceived, (payload) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as DataMessage;
        if (msg && (msg.kind === "error" || msg.kind === "info") && typeof msg.message === "string") {
          opts.onMessage?.(msg);
        }
      } catch {
        // ignore non-JSON payloads
      }
    });

  await room.connect(d.livekitUrl, d.token);
  // Always pre-warm the mic device so the browser permission prompt fires
  // here, not on the first manual-mode tap. We immediately mute if the user
  // is in manual mode — setMicrophoneEnabled(true) is needed to publish a
  // track at all.
  await room.localParticipant.setMicrophoneEnabled(true);
  if (!opts.startMicEnabled) {
    await setMicMutedOnTrack(room, true);
    log("manual mode: mic muted (tap Talk to unmute)");
  } else {
    log("microphone enabled");
  }

  const disconnect = async () => {
    await room.disconnect();
    audioElement.remove();
  };

  return { room, audioElement, disconnect };
}

/**
 * Mute or unmute the mic without unpublishing the track. Faster than
 * setMicrophoneEnabled(false) (which tears down the track) and survives
 * repeated toggles.
 */
async function setMicMutedOnTrack(room: Room, muted: boolean) {
  const pub = Array.from(room.localParticipant.trackPublications.values()).find(
    (p) => p.kind === Track.Kind.Audio,
  );
  if (!pub?.track) return;
  if (muted) await pub.mute();
  else await pub.unmute();
}

export async function setMicMuted(handle: VoiceHandle, muted: boolean): Promise<void> {
  await setMicMutedOnTrack(handle.room, muted);
}

export function isMicMuted(handle: VoiceHandle): boolean {
  const pub = Array.from(handle.room.localParticipant.trackPublications.values()).find(
    (p) => p.kind === Track.Kind.Audio,
  );
  return pub?.isMuted ?? true;
}
