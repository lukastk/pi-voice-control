import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteParticipant,
} from "livekit-client";
import type { DispatchResult } from "./api.ts";

export type VoiceState = "idle" | "connecting" | "connected" | "error";

export type VoiceHandle = {
  room: Room;
  audioElement: HTMLAudioElement;
  disconnect: () => Promise<void>;
};

export async function connectVoice(d: DispatchResult, log: (msg: string) => void): Promise<VoiceHandle> {
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
    });

  await room.connect(d.livekitUrl, d.token);
  await room.localParticipant.setMicrophoneEnabled(true);
  log("microphone enabled");

  const disconnect = async () => {
    await room.disconnect();
    audioElement.remove();
  };

  return { room, audioElement, disconnect };
}
