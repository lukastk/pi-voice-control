import {
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
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
  audioContext: AudioContext | null;
  disconnect: () => Promise<void>;
};

export async function connectVoice(
  d: DispatchResult,
  log: (msg: string) => void,
  opts: { startMicEnabled: boolean; onMessage?: (msg: DataMessage) => void },
): Promise<VoiceHandle> {
  // Secure-context preflight: getUserMedia is blocked on http:// from any
  // non-localhost host. Without this, the browser throws an opaque
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

  // Single audio path: a real <audio> element. On the Android wrapper the
  // foreground service claims AudioFocus + USAGE_MEDIA + CONTENT_TYPE_SPEECH,
  // which is what tells the OS "we're ongoing voice playback" and prevents
  // Chromium from pausing the element on visibility change. We previously
  // tried Web Audio routing as a workaround for screen-off pauses (before
  // AudioFocus was claimed), but that introduced its own failure modes
  // (Chromium MediaStream decoder bug, audio breaking after long agent
  // responses) and produced a "tunnel" sound when running alongside the
  // element. With AudioFocus the simple path is the right one.
  const audioElement = document.createElement("audio");
  audioElement.autoplay = true;
  audioElement.muted = false;
  audioElement.style.display = "none";
  audioElement.setAttribute("playsinline", "");
  document.body.appendChild(audioElement);

  // Kept for parity with the type signature; not used as a playback path.
  const audioContext: AudioContext | null = null;

  const attachAudioTrack = (track: RemoteAudioTrack) => {
    track.attach(audioElement);
    log("audio routed via HTMLAudioElement (AudioFocus keeps it alive in background)");
  };

  const detachAudioTrack = (track: RemoteTrack) => {
    track.detach().forEach((el) => el.remove());
  };

  room
    .on(RoomEvent.Connected, () => log("connected"))
    .on(RoomEvent.Disconnected, (reason) => {
      log(`disconnected: ${reason ?? "unknown"}`);
      opts.onMessage?.({
        kind: "error",
        source: "WebRTC",
        message: `Voice link dropped (${reason ?? "unknown"}). Reconnect from Sessions tab.`,
      });
    })
    .on(RoomEvent.Reconnecting, () => {
      log("reconnecting…");
      opts.onMessage?.({
        kind: "info",
        source: "WebRTC",
        message: "Voice link reconnecting…",
      });
    })
    .on(RoomEvent.Reconnected, () => {
      log("reconnected");
      opts.onMessage?.({
        kind: "info",
        source: "WebRTC",
        message: "Voice link restored.",
      });
    })
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => log(`participant: ${p.identity}`))
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        attachAudioTrack(track as RemoteAudioTrack);
      }
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      detachAudioTrack(track);
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

  // Server hands back ws://localhost:7880 because that's how it knows the
  // LiveKit instance. From a mobile/Tailscale client, "localhost" means the
  // phone itself. Rewrite the hostname to match the page's host so
  // ws://<host>:7880 resolves to the same machine the HTTP server is on.
  const livekitUrl = rewriteLocalhost(d.livekitUrl);
  await room.connect(livekitUrl, d.token);

  // Tell Android we're playing legitimate ongoing media so it doesn't
  // throttle the HTMLAudioElement when the screen turns off. Without this,
  // Chromium-based WebViews pause longer audio playback on visibility
  // change — earcons (80 ms) slip through before the throttle, longer TTS
  // gets cut off mid-stream. Same mechanism Spotify/YouTube use.
  enableBackgroundMediaPlayback(audioElement);

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
    document.querySelectorAll('audio[data-role="voice-bridge-keepalive"]').forEach((el) => el.remove());
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "none";
        navigator.mediaSession.metadata = null;
      } catch {
        // ignore
      }
    }
  };

  return { room, audioElement, audioContext, disconnect };
}

/**
 * Mark the page as actively playing media so Android Chromium / WebView
 * doesn't pause the agent's audio track when the screen turns off.
 *
 * Three layers because no single one is bulletproof on every Android
 * surface (system WebView, Chrome PWA, Samsung Internet, etc.):
 *
 *   1. MediaSession API — declares ongoing media metadata; Android shows it
 *      in lockscreen controls and treats it as background-eligible.
 *   2. Loop a 1-frame-of-silence audio file so an HTMLAudioElement is
 *      always "actively playing" from the browser's policy perspective.
 *      Earcons-only worked previously because they kept hitting the
 *      element; longer TTS got cut once the browser re-evaluated state.
 *   3. AudioContext.resume() on the silence track — some Chromium versions
 *      gate audio playback on AudioContext state regardless of the element.
 */
function enableBackgroundMediaPlayback(audioElement: HTMLAudioElement) {
  if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Voice Bridge",
        artist: "Pi",
      });
      navigator.mediaSession.playbackState = "playing";
      // Empty action handlers — declaring them is enough to claim the
      // session; we don't do anything special on play/pause/seek.
      const noop = () => {};
      try { navigator.mediaSession.setActionHandler("play", noop); } catch {}
      try { navigator.mediaSession.setActionHandler("pause", noop); } catch {}
    } catch {
      // best-effort
    }
  }

  // Silent keep-alive: a 1-second silent WAV looped indefinitely on a
  // dedicated audio element. The agent's track is attached to a different
  // element; this one only exists so the page reliably has an actively
  // playing media element across visibility changes.
  try {
    const keepalive = document.createElement("audio");
    keepalive.src = SILENT_WAV_DATA_URL;
    keepalive.loop = true;
    keepalive.autoplay = true;
    keepalive.style.display = "none";
    keepalive.dataset.role = "voice-bridge-keepalive";
    document.body.appendChild(keepalive);
    keepalive.play().catch(() => {
      // autoplay can fail without a user gesture; the page already had a
      // gesture (Connect voice click) so this should normally succeed.
    });
    // Tag the agent audio element too so disconnect can clean both up.
    audioElement.dataset.role = "voice-bridge-agent";
  } catch {
    // best-effort
  }
}

/**
 * 1 second of silence as a base64 WAV (mono, 8 kHz, s8). Used as the
 * loop source for the keep-alive audio element. Tiny — under 1 KB.
 */
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YR" +
  "AAAACAgICAgICAgICAgICAgIA=";

/**
 * If the URL points at localhost / 127.0.0.1 / ::1, swap the hostname for
 * the page's current hostname. Required for mobile / Tailscale access where
 * "localhost" on the client = the phone itself, not the Mac running LiveKit.
 * Also upgrade ws:// to wss:// when the page itself is on https — Tailscale
 * Serve / any HTTPS proxy in front of LiveKit only accepts TLS, and a plain
 * ws:// to a TLS-only port silently hangs instead of erroring.
 *
 * Leaves explicit external hostnames alone (other than the scheme upgrade)
 * so a deployment behind a real LiveKit URL still works.
 */
function rewriteLocalhost(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    const u = new URL(url);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") {
      u.hostname = window.location.hostname;
    }
    if (window.location.protocol === "https:" && u.protocol === "ws:") {
      u.protocol = "wss:";
    }
    return u.toString();
  } catch {
    return url;
  }
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
