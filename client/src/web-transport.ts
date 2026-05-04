/**
 * WebTransport — drives a LiveKit Room via the LiveKit Web SDK. Used in
 * desktop browsers, mobile browsers, and iOS / "add to home screen" PWAs.
 *
 * The Android wrapper uses NativeTransport instead because the WebView's
 * audio path doesn't survive screen-off (see PLAN-NATIVE-AUDIO.md §2).
 */
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteTrack,
} from "livekit-client";
import type { DispatchResult } from "./api.ts";
import {
  rewriteLocalhost,
  VoiceEventEmitter,
  type VoiceTransport,
} from "./voice-transport.ts";

export class WebTransport extends VoiceEventEmitter implements VoiceTransport {
  private room: Room | null = null;
  private audioElement: HTMLAudioElement | null = null;

  async connect({
    dispatch,
    turnMode,
  }: {
    dispatch: DispatchResult;
    turnMode: "vad" | "manual" | "keyword";
  }): Promise<void> {
    // Secure-context preflight: getUserMedia is blocked on http:// from
    // any non-localhost host. Without this, the browser throws an opaque
    // "Cannot read properties of undefined (reading 'getUserMedia')" deep
    // inside LiveKit's setMicrophoneEnabled, which the user has no way to
    // map back to "I'm on http and need https".
    const secureCtx =
      typeof window === "undefined" ||
      window.isSecureContext ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!secureCtx) {
      const host = window.location.hostname;
      throw new Error(
        `Microphone access requires HTTPS on remote hosts. You're on http://${host} ` +
          `which the browser treats as insecure. Run \`tailscale serve --bg --https=443 http://localhost:7890\` ` +
          `(and the same for ports 7880 + 7891) on the Mac, then open https://${host}/ — see README "Tailscale + HTTPS".`,
      );
    }

    const room = new Room({
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.room = room;

    // Single audio path: a real <audio> element. On the Android wrapper
    // (which uses NativeTransport) the SDK creates its own AudioTrack on
    // STREAM_VOICE_CALL; this WebTransport path is for browsers, where
    // attaching the LiveKit track to an HTMLAudioElement is the standard
    // approach. The MediaSession + silent-keepalive layer below mitigates
    // browser background-tab audio throttling on Android Chrome.
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.muted = false;
    audioElement.style.display = "none";
    audioElement.setAttribute("playsinline", "");
    document.body.appendChild(audioElement);
    this.audioElement = audioElement;

    room
      .on(RoomEvent.Disconnected, (reason) => {
        // CLIENT_INITIATED (= 1) means the SDK fired Disconnected because
        // we called room.disconnect() ourselves — e.g. during a mode-toggle
        // reconnect. Surface that as reason="user" so the voice.ts toast
        // suppression skips the "Voice link dropped" warning. Anything
        // else (server kick, network loss, etc.) keeps the original reason.
        const userInitiated = reason === DisconnectReason.CLIENT_INITIATED;
        this.emit({
          type: "disconnected",
          reason: userInitiated ? "user" : String(reason ?? "unknown"),
        });
      })
      .on(RoomEvent.Reconnecting, () => {
        this.emit({ type: "reconnecting" });
      })
      .on(RoomEvent.Reconnected, () => {
        this.emit({ type: "reconnected" });
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          (track as RemoteAudioTrack).attach(audioElement);
          console.log("[WebTransport] audio track subscribed", track.sid);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        // Detach the track from any elements but DON'T remove the
        // elements themselves. The agent cycles tracks between utterances
        // (earcons / pipelineReply / tool replies in livekit-agents);
        // removing our shared audioElement on every unsubscribe meant
        // the next track had nowhere to play, so anything past the first
        // utterance was silent. The element is cleaned up in disconnect().
        track.detach();
        if (track.kind === Track.Kind.Audio) {
          console.log("[WebTransport] audio track unsubscribed", track.sid);
        }
      })
      .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        try {
          const message = JSON.parse(new TextDecoder().decode(payload));
          this.emit({ type: "data", topic: topic ?? "", message });
        } catch {
          // ignore non-JSON payloads
        }
      });

    const livekitUrl = rewriteLocalhost(dispatch.livekitUrl);
    try {
      await room.connect(livekitUrl, dispatch.token);
    } catch (err: any) {
      this.emit({ type: "error", source: "livekit", message: err?.message ?? String(err) });
      throw err;
    }

    enableBackgroundMediaPlayback(audioElement);

    // Always pre-warm the mic device so the browser permission prompt
    // fires here, not on the first manual-mode tap. We immediately mute
    // if the user is in manual mode — setMicrophoneEnabled(true) is
    // needed to publish a track at all.
    await room.localParticipant.setMicrophoneEnabled(true);
    if (turnMode === "manual") {
      await this.muteTrack(true);
    }

    this.emit({ type: "connected", roomName: dispatch.roomName });
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect();
    if (this.audioElement) {
      this.audioElement.remove();
      this.audioElement = null;
    }
    document.querySelectorAll('audio[data-role="voice-bridge-keepalive"]').forEach((el) => el.remove());
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "none";
        navigator.mediaSession.metadata = null;
      } catch {
        // best-effort
      }
    }
    this.emit({ type: "disconnected", reason: "user" });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    await this.muteTrack(muted);
    this.emit({ type: "mic-state", muted });
  }

  private async muteTrack(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    const pub = Array.from(room.localParticipant.trackPublications.values()).find(
      (p) => p.kind === Track.Kind.Audio,
    );
    if (!pub?.track) return;
    if (muted) await pub.mute();
    else await pub.unmute();
  }
}

/**
 * Mark the page as actively playing media so Android Chromium / WebView
 * doesn't pause the agent's audio track when the screen turns off.
 *
 * Three layers because no single one is bulletproof on every Android
 * surface (system WebView, Chrome PWA, Samsung Internet, etc.):
 *
 *   1. MediaSession API — declares ongoing media metadata; Android shows
 *      it in lockscreen controls and treats it as background-eligible.
 *   2. Silent keep-alive audio element looped indefinitely — gives the
 *      page an "actively playing" media element across visibility changes.
 *      Earcons-only worked previously because they kept hitting the
 *      element; longer TTS got cut once the browser re-evaluated state.
 *
 * Inside the Android wrapper (NativeTransport) these workarounds are
 * unnecessary — the native SDK's own audio session takes over. They
 * remain useful for plain Chrome / Samsung Internet PWA installs.
 */
function enableBackgroundMediaPlayback(audioElement: HTMLAudioElement) {
  if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Voice Bridge",
        artist: "Pi",
      });
      navigator.mediaSession.playbackState = "playing";
      const noop = () => {};
      try { navigator.mediaSession.setActionHandler("play", noop); } catch {}
      try { navigator.mediaSession.setActionHandler("pause", noop); } catch {}
    } catch {
      // best-effort
    }
  }

  try {
    const keepalive = document.createElement("audio");
    keepalive.src = SILENT_WAV_DATA_URL;
    keepalive.loop = true;
    keepalive.autoplay = true;
    keepalive.style.display = "none";
    keepalive.dataset.role = "voice-bridge-keepalive";
    document.body.appendChild(keepalive);
    keepalive.play().catch(() => {
      // autoplay can fail without a user gesture; the page already had
      // a gesture (Connect voice click) so this should normally succeed.
    });
    audioElement.dataset.role = "voice-bridge-agent";
  } catch {
    // best-effort
  }
}

/** 1 second of silence as a base64 WAV (mono, 8 kHz, s8). Under 1 KB. */
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YR" +
  "AAAACAgICAgICAgICAgICAgIA=";
