# Plan — Native LiveKit audio in the Android wrapper

Last updated: 2026-05-03. Supersedes the WebView-only audio path inside the Android wrapper. The desktop browser / iOS Safari / "Add-to-Home-Screen" PWA paths are unchanged and continue to use the LiveKit Web SDK.

---

## 1. The goal in one sentence

Move the audio path of the Android wrapper out of Chromium's WebView and into the LiveKit Android SDK, so audio keeps playing reliably with the screen off — without rewriting the React UI.

## 2. Why we ended up here

We spent a session iterating on browser-side workarounds for the screen-off-pauses-audio problem. They each made things slightly better but never fully reliable, and several broke on long agent responses or produced "tunnel" audio. The dumpsys data we captured live gave the definitive answer:

```
Audio Focus stack:
  1. VoiceForegroundService — gain: GAIN              — loss: LOSS_TRANSIENT_CAN_DUCK
  2. Chromium AudioFocusDelegate — gain: GAIN_TRANSIENT_MAY_DUCK — loss: none   ← top
```

Two facts that together close off the WebView path:

1. **The WebView grabs its own AudioFocus** as `GAIN_TRANSIENT_MAY_DUCK` whenever an audio element starts playing, regardless of what our service holds. The transient type is exactly what gets paused on visibility change.
2. **There's no JS or WebView API to change Chromium's stream selection.** It's hardcoded to `STREAM_MUSIC` with `USAGE_MEDIA`. Putting our app into `MODE_IN_COMMUNICATION` (the proper VoIP mode) silences `STREAM_MUSIC`, so the WebView's audio becomes inaudible.

Net: we cannot make Chromium's audio behave like a phone-call audio session from outside the WebView.

The native LiveKit SDK produces its own audio. It owns the AudioTrack, AudioRecord, focus claim, and mode. It can use `STREAM_VOICE_CALL` + `MODE_IN_COMMUNICATION` without any conflict, because there's no WebView audio for that mode to silence. Same pattern that ChatGPT, Discord, WhatsApp, Zoom use — the user's correct intuition.

## 3. Architecture decision: hybrid (WebView UI + native audio)

Three architectures considered:

| Option | Description | Pro | Con |
|---|---|---|---|
| A. Full native | Replace WebView with native Compose UI + native SDK | Cleanest control | Reimplement 4 tabs, 6 components, full state machine, Settings forms — weeks of work |
| **B. Hybrid (chosen)** | WebView keeps the UI; native takes over LiveKit Room + audio | Reuses 100% of React app; small native surface | One JS↔native interface to maintain |
| C. Native sidecar | Native runs a WebRTC client that forwards via WebSockets to the WebView; WebView still has its own LiveKit | Negligible UI changes | Doubles WebRTC connections; nightmarish state sync |

We pick **B**. Native code is small and additive; the JS app gets one new concrete `VoiceTransport` implementation alongside the existing Web SDK one, gated by feature detection. Browser-only users (desktop, PWA without wrapper) keep the Web SDK path. The Android wrapper users transparently get the native path.

## 4. Component diagram

```
┌────────────────────── Android Activity ─────────────────────┐
│                                                             │
│  ┌────────────── WebView (Chromium) ─────────────────────┐  │
│  │                                                       │  │
│  │  React UI (unchanged)                                 │  │
│  │   ├─ Sessions tab, Terminal tab, Settings tab, …      │  │
│  │   └─ useVoice() hook                                  │  │
│  │        │                                              │  │
│  │        ▼  picks transport at runtime                  │  │
│  │   VoiceTransport interface                            │  │
│  │   ├─ WebTransport  (browser / no native bridge)       │  │
│  │   └─ NativeTransport ───── window.AndroidVoiceBridge ─┼──┐
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────── VoiceBridge (Kotlin) ─────────────────────┐  │
│  │   @JavascriptInterface methods, called from JS:       │  │
│  │     connect(url, token, roomName, identity)           │  │
│  │     disconnect()                                      │  │
│  │     setMicMuted(muted)                                │  │
│  │     getDiagnostics()                                  │  │
│  │   Kotlin → JS callbacks via webView.evaluateJavascript: │  │
│  │     onConnected / onDisconnected / onReconnect…       │  │
│  │     onDataReceived(json)                              │  │
│  │     onError(msg)                                      │  │
│  │                                                       │  │
│  │   Owns:                                               │  │
│  │     io.livekit.android.Room                           │  │
│  │     LocalParticipant.publishAudioTrack(mic)           │  │
│  │     RemoteAudioTrack subscription (auto-played by SDK)│  │
│  │     AudioSwitchHandler (the SDK's audio session mgr)  │  │
│  └───────────────────────────────────────────────────────┘  │
│                              │                              │
│  ┌──────── VoiceForegroundService (existing) ────────────┐  │
│  │   Foreground notification + WAKE_LOCK                 │  │
│  │   AudioFocus claim REMOVED — SDK does this itself now │  │
│  │   (kept just for "process won't die" + lock-screen UI)│  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼ libwebrtc native sockets
                       LiveKit server (Tailscale-fronted)
```

The WebView is still rendered, still shows the React app, still receives the user's interactions, still talks to the Bun server over HTTPS for everything that *isn't* the LiveKit room (sessions list, prompt edit, config save, dispatch token request, wterm iframe). The *only* thing that moves is the LiveKit Room object and the audio.

## 5. JS ↔ Native bridge protocol

Single `JavascriptInterface` object exposed at `window.AndroidVoiceBridge`. JS detects it; if absent, falls back to Web SDK.

### JS → Native (synchronous, return value as `Boolean` / `String`)

| Method | Args | Returns | Semantics |
|---|---|---|---|
| `connect(url, token, roomName, identity, manualMode)` | strings + bool | `true` if accepted | Native creates and connects the Room asynchronously. Returns immediately; subsequent state arrives via callbacks. Throws synchronously on missing perms. |
| `disconnect()` | — | — | Native destroys the Room and releases audio session. |
| `setMicMuted(muted)` | bool | — | Native mutes/unmutes the published mic track without unpublishing. |
| `getStateJson()` | — | JSON string | Snapshot of current state (connected, micMuted, lastError). For diagnostics; not the primary state path. |
| `playEarcon(kind)` | string | — | Optional later; not in v1 since the agent publishes earcons through its own track. |

### Native → JS (async, via `evaluateJavascript`)

The native side calls `window.__voiceBridge.dispatch(<json>)` which the JS side wires to internal handlers. JSON envelope:

```json
{ "type": "connected" | "disconnected" | "reconnecting" | "reconnected"
       | "data" | "error" | "permission-denied" | "mic-state" ,
  "payload": { … } }
```

Concrete payloads:

- `connected`: `{ roomName }`
- `disconnected`: `{ reason }`
- `reconnecting`: `{}`
- `reconnected`: `{}`
- `data`: `{ topic, message }` (topic="voice-bridge"; message is the parsed JSON the worker sent)
- `error`: `{ source, message }` (e.g. `source:"livekit"`, `source:"audio"`)
- `mic-state`: `{ muted }` (when the SDK changes mic state under us)

Wire format note: stringify on the Kotlin side, parse on the JS side. Avoid passing typed JS objects through the bridge — `JavascriptInterface` only does primitives + strings.

## 6. Native module design (Kotlin)

### 6.1 Maven dep + min SDK

```kotlin
// android/app/build.gradle.kts
dependencies {
    implementation("io.livekit:livekit-android:2.25.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
}
```

Adds ~20–25 MB AAR (libwebrtc.so for arm64). `minSdk 26` already in our config; LiveKit SDK requires 24+.

### 6.2 New file: `VoiceBridge.kt`

```kotlin
class VoiceBridge(
    private val activity: AppCompatActivity,
    private val webView: WebView,
) {
    private var room: Room? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    @JavascriptInterface
    fun connect(url: String, token: String, roomName: String,
                identity: String, manualMode: Boolean): Boolean {
        scope.launch {
            try {
                val r = LiveKit.create(activity.application,
                    overrides = LiveKitOverrides(
                        // default = two-way communications (VoIP).
                        // No override needed; SDK manages MODE_IN_COMMUNICATION,
                        // AudioFocus, STREAM_VOICE_CALL, speakerphone routing.
                    ))
                r.connect(url, token,
                    options = ConnectOptions(autoSubscribe = true))
                r.localParticipant.setMicrophoneEnabled(!manualMode)
                room = r
                attachListeners(r)
                emit("connected", JSONObject().put("roomName", roomName))
            } catch (t: Throwable) {
                emit("error", JSONObject()
                    .put("source", "livekit")
                    .put("message", t.message ?: t.javaClass.simpleName))
            }
        }
        return true
    }

    @JavascriptInterface
    fun disconnect() {
        scope.launch {
            room?.disconnect()
            room = null
            emit("disconnected", JSONObject().put("reason", "user"))
        }
    }

    @JavascriptInterface
    fun setMicMuted(muted: Boolean) {
        scope.launch {
            room?.localParticipant?.setMicrophoneEnabled(!muted)
            emit("mic-state", JSONObject().put("muted", muted))
        }
    }

    private fun attachListeners(r: Room) {
        scope.launch {
            r.events.collect { ev ->
                when (ev) {
                    is RoomEvent.Disconnected -> emit("disconnected",
                        JSONObject().put("reason", ev.reason?.name ?: "unknown"))
                    is RoomEvent.Reconnecting -> emit("reconnecting", JSONObject())
                    is RoomEvent.Reconnected  -> emit("reconnected", JSONObject())
                    is RoomEvent.DataReceived -> {
                        val topic = ev.topic ?: ""
                        val msg = String(ev.data, Charsets.UTF_8)
                        emit("data", JSONObject()
                            .put("topic", topic)
                            .put("message", JSONObject(msg)))
                    }
                    is RoomEvent.FailedToConnect -> emit("error",
                        JSONObject().put("source","livekit").put("message", ev.error.message))
                    else -> {} // Track add/remove are handled by SDK auto-subscribe
                }
            }
        }
    }

    private fun emit(type: String, payload: JSONObject) {
        val js = """window.__voiceBridge && window.__voiceBridge.dispatch(
                       ${JSONObject().put("type", type).put("payload", payload)})"""
            .replace("\n", " ")
        activity.runOnUiThread { webView.evaluateJavascript(js, null) }
    }
}
```

### 6.3 `MainActivity.kt` changes

```kotlin
override fun onCreate(...) {
    …
    val bridge = VoiceBridge(this, webView)
    webView.addJavascriptInterface(bridge, "AndroidVoiceBridge")
    // Existing WebView setup unchanged.
}
```

### 6.4 `VoiceForegroundService.kt` changes

Strip out the AudioFocus/SpeakerphoneOn code we added. The LiveKit Android SDK requests its own focus correctly. Keep:
- Foreground notification (so the OS doesn't kill the process)
- `PARTIAL_WAKE_LOCK` (CPU stays awake)
- Service type `microphone | mediaPlayback`

The reason to keep the foreground service at all: it's what holds the process alive when the screen is off. Without it, Android can kill us. With it, we live, and the native LiveKit SDK keeps running its audio.

### 6.5 Threading

`@JavascriptInterface` methods run on a binder thread. We launch on `Dispatchers.Main` for SDK calls (most LiveKit APIs are main-thread or main-safe) and `evaluateJavascript` always on the UI thread.

### 6.6 Permissions

Already in manifest from the previous round: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`, `WAKE_LOCK`, `FOREGROUND_SERVICE` and the typed variants. No new ones needed.

## 7. JS-side abstraction (`client/src/voice-transport.ts`)

A new `VoiceTransport` interface with two implementations. `useVoice` hook becomes transport-agnostic.

```ts
export interface VoiceTransport {
  connect(args: { dispatch: DispatchResult; turnMode: "vad" | "manual" }): Promise<void>;
  disconnect(): Promise<void>;
  setMicMuted(muted: boolean): Promise<void>;
  on<E extends VoiceEvent["type"]>(type: E, handler: (ev: Extract<VoiceEvent, {type:E}>) => void): () => void;
}

export type VoiceEvent =
  | { type: "connected"; roomName: string }
  | { type: "disconnected"; reason: string }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "data"; topic: string; message: any }
  | { type: "error"; source: string; message: string }
  | { type: "mic-state"; muted: boolean };

export function pickTransport(): VoiceTransport {
  if (typeof window !== "undefined" && (window as any).AndroidVoiceBridge) {
    return new NativeTransport();
  }
  return new WebTransport(); // current livekit.ts logic
}
```

`NativeTransport` wires `window.__voiceBridge.dispatch(json)` as its event ingress. It also exposes a small global function so the bridge can find it on first use.

`useVoice` calls `pickTransport()` once on mount, then drives the same VoiceState machine regardless of which transport ran. The existing toast / log infrastructure consumes `error` and `data` events identically across transports.

## 8. Audio session strategy

We delegate everything to the SDK:

- **Capture**: SDK's `LocalAudioTrack` uses `MediaRecorder.AudioSource.VOICE_COMMUNICATION` source — built-in NS / AEC / AGC tuned for voice.
- **Playback**: SDK creates an `AudioTrack` on `STREAM_VOICE_CALL` with `USAGE_VOICE_COMMUNICATION` + `CONTENT_TYPE_SPEECH`.
- **Mode**: SDK sets `MODE_IN_COMMUNICATION` while connected, restores `MODE_NORMAL` on disconnect. Because we don't have any HTMLAudioElement audio happening any more, there's no conflict — STREAM_MUSIC being silenced doesn't matter to us.
- **Focus**: SDK requests `AUDIOFOCUS_GAIN` with the right attributes.
- **Speakerphone**: SDK's default is "stay on whatever device the OS preferred" — Bluetooth wins when paired, otherwise loudspeaker for voice-comm mode. We can override via `AudioSwitchHandler` if needed.

Volume rocker: `MainActivity.volumeControlStream = AudioManager.STREAM_VOICE_CALL` (matches where audio plays now).

## 9. State machine + lifecycle

### 9.1 Per-session lifecycle

```
[idle] --user clicks Connect voice--> [connecting]
[connecting] --bridge.connect() returns--> wait for "connected" event
[connecting] --error event-->        [error]
[connecting] --connected event-->    [connected]
[connected] --user clicks Disconnect--> [disconnecting]
[connected] --disconnected event-->  [idle]
[connected] --reconnecting event-->  [reconnecting]
[reconnecting] --reconnected event--> [connected]
[reconnecting] --disconnected (giveup)--> [idle] + error toast
```

Same machine as today. The transport boundary doesn't leak into UI logic.

### 9.2 App lifecycle

- `Activity.onCreate`: register `AndroidVoiceBridge` JS interface.
- `Activity.onPause` / `onStop`: WebView keeps running; bridge keeps room. No tear-down.
- `Activity.onDestroy`: bridge.disconnect() if connected. Bridge releases coroutine scope.
- Foreground service: started when JS calls `connect()`, stopped on `disconnect()`. (Today the service starts at app launch; we can simplify or leave as-is — leaving as-is for v1.)

### 9.3 Backgrounding

When the screen turns off:
- Activity moves to PAUSED → STOPPED.
- WebView is still alive (foreground service keeps process).
- LiveKit native SDK is running on its own thread, doesn't care about UI lifecycle.
- Audio keeps playing through `AudioTrack` on STREAM_VOICE_CALL with `MODE_IN_COMMUNICATION`.
- Mic keeps capturing from `MediaRecorder.AudioSource.VOICE_COMMUNICATION`.

This is exactly the path ChatGPT/Discord/Zoom use.

### 9.4 When the user kills the app from the recents tray

`onTaskRemoved` fires → service stops → process dies → SDK Room disconnects → LiveKit server frees the slot. Same as today.

## 10. Risks and open questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| LiveKit SDK transitive deps clash with appcompat / core-ktx | low | `./gradlew :app:dependencies`; pin if needed |
| `MODE_IN_COMMUNICATION` UX side effects (volume rocker, BT routing) | medium | already accept; adjust `volumeControlStream` |
| JS-bridge race conditions (call disconnect while connect still running) | medium | bridge tracks an in-flight `connect` job; cancel + replace |
| Web SDK and native SDK both holding rooms accidentally during a transport-switch bug | low | feature-detect once on mount, never switch transports mid-session |
| Native SDK's auto-subscribe brings down a video track if agent ever publishes one | low | SDK only auto-subscribes audio when it's the only kind subscribed; we configure `audioOnly` if needed |
| APK size +20–25 MB | known | acceptable for a sideloaded personal-use app |
| `evaluateJavascript` payloads with embedded `</script>` etc. | low | we only pass JSONObject.toString → safe |
| Reconnect loop on poor network | low | SDK handles. Surface "reconnecting" toast (already wired) |
| `RECORD_AUDIO` permission revoked while connected | low | SDK errors → we surface via `error` event |
| LiveKit SDK requires its own libwebrtc which conflicts with Chromium's | extremely low | they live in different processes, no conflict |
| User runs old client bundle that calls Web SDK in the wrapper | medium | feature-detect at bridge presence, not at build time; bundle reload picks up new logic |

Open questions worth answering before implementation:

- Q1: Does `LiveKit.create` block? → No, it's a builder; `room.connect` is the suspending call.
- Q2: Does `RoomEvent.DataReceived` parse JSON for us? → No, we get `ByteArray`. We `String(bytes)` then `JSONObject(...)`.
- Q3: Do we keep the silent keep-alive `<audio>` and MediaSession metadata on the JS side when running in the wrapper? → No. Drop them when `NativeTransport` is in use; they were workarounds for the now-bypassed Chromium audio path.
- Q4: How does the wterm tab fare? → Untouched. Its audio (none) and pty WebSocket (unchanged) live entirely in the WebView.
- Q5: Earcons — still produced server-side, still arrive via the same agent track, played by SDK without special handling.

## 11. Phasing

Six small commits, each self-contained and testable.

### Phase 9.1 — Native dep + skeleton (no JS changes)

- Add `io.livekit:livekit-android:2.25.1` to `android/app/build.gradle.kts`.
- Add empty `VoiceBridge.kt` with the four `@JavascriptInterface` methods returning early.
- Wire `webView.addJavascriptInterface(bridge, "AndroidVoiceBridge")` in `MainActivity.onCreate`.
- Build + install.
- **Exit criterion**: `adb shell dumpsys` shows the new dep loaded; opening the app's WebView console shows `window.AndroidVoiceBridge` is defined; nothing else changed yet.

### Phase 9.2 — Native connect/disconnect, no audio

- `connect()` actually constructs the Room and connects.
- `disconnect()` tears down.
- Listeners forward connected/disconnected events to JS via `__voiceBridge.dispatch`.
- Mic publishing left disabled for now.
- **Exit criterion**: with debug logging in JS, clicking Connect causes a "connected" event to fire from native within ~1 s; LiveKit server logs show a participant joining. Disconnect cleanly removes the participant.

### Phase 9.3 — Mic publish + audio playback

- `setMicrophoneEnabled(true)` on connect, `setMicMuted` wired.
- SDK auto-plays remote audio (no extra code).
- Confirm audio plays through `STREAM_VOICE_CALL`.
- **Exit criterion**: speak → agent hears via mic; agent's TTS plays through the phone speaker; confirmed via `dumpsys audio | grep STREAM` showing active VOICE_CALL stream.

### Phase 9.4 — JS transport abstraction

- `client/src/voice-transport.ts` with `VoiceTransport` interface + `WebTransport` (refactor of current logic) + `NativeTransport`.
- `useVoice` calls `pickTransport()` once.
- All existing tests / flows still work in desktop browser (uses `WebTransport`).
- **Exit criterion**: desktop voice still works; the wrapper Connect path now goes through `NativeTransport` and the native bridge; log line confirms transport selection.

### Phase 9.5 — Data channel + error surfacing

- Wire `RoomEvent.DataReceived` → `data` event → existing toast handler.
- Wire `RoomEvent.FailedToConnect` / generic errors → `error` event.
- **Exit criterion**: TTS errors from server (verified via the existing diagnostic — set a bogus voice ID) show in the toast on the wrapper.

### Phase 9.6 — Lifecycle + cleanup

- Drop the now-unused MediaSession + silent-keepalive code from `client/src/livekit.ts` when running under `NativeTransport`.
- Strip AudioFocus / speakerphone code from `VoiceForegroundService.kt` (SDK does it).
- Long-screen-off test (the original goal).
- **Exit criterion**: 1 hour screen-off conversation works without audio drops.

Estimated total: 1–2 evenings.

## 12. Rollback story

If anything breaks badly mid-phase:

- The PWA path is untouched throughout — desktop browser users always work.
- The Android wrapper's old code is in git; revert `android/` directory to the commit before this work and reinstall.
- The JS transport selector ensures even a buggy native bridge can be disabled by removing `window.AndroidVoiceBridge` (e.g. by force-stopping the wrapper and testing in plain Chrome).

## 13. Out of scope for this plan

- iOS native wrapper. Same hybrid pattern would apply, but no iOS app exists yet.
- Multi-room / multi-session inside the wrapper.
- In-call notifications (call style, ringing, CallKit-equivalent on Android).
- Picture-in-picture / floating mic toggle.

These are clean follow-ups once the audio path is stable.
