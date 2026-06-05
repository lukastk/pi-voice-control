package com.voiceagentbridge

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.DataPublishReliability
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONArray
import org.json.JSONObject

/**
 * JS↔native bridge: the React app calls into this via window.AndroidVoiceBridge
 * instead of using the LiveKit Web SDK, so audio survives screen-off.
 *
 * Background — Chromium's WebView grabs its own AudioFocus as
 * GAIN_TRANSIENT_MAY_DUCK and routes media through STREAM_MUSIC with
 * USAGE_MEDIA. There's no JS or WebView API to change this. Putting our app
 * into MODE_IN_COMMUNICATION silences STREAM_MUSIC system-wide, so the
 * WebView's audio becomes inaudible. The fix is to bypass the WebView for
 * the audio path: this class owns a native LiveKit Room which the SDK plumbs
 * through STREAM_VOICE_CALL with MODE_IN_COMMUNICATION — same pattern
 * ChatGPT, Discord, Zoom use.
 *
 * Threading — @JavascriptInterface methods run on a binder thread, NOT the
 * UI thread. We launch onto Dispatchers.Main for SDK calls (LiveKit's APIs
 * are main-safe) and webView.evaluateJavascript runs on the UI thread.
 *
 * Phasing (PLAN-NATIVE-AUDIO.md §11):
 *   9.1 — JS interface scaffolded, methods log only.
 *   9.2 — connect/disconnect drive a real Room; events forwarded to JS.
 *   9.3 — mic publish + audio playback verified on STREAM_VOICE_CALL.
 *   9.5 — RoomEvent.DataReceived → "data" event for toast surface.
 */
class VoiceBridge(
    private val activity: AppCompatActivity,
    private val webView: WebView,
) {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    @Volatile private var room: Room? = null
    @Volatile private var micMuted: Boolean = true
    private var eventsJob: Job? = null

    @JavascriptInterface
    fun connect(
        url: String,
        token: String,
        roomName: String,
        identity: String,
        manualMode: Boolean,
        micDeviceId: String,
    ): Boolean {
        // Don't log url/token — token is a JWT credential.
        Log.i(TAG, "connect(room=$roomName, identity=$identity, manual=$manualMode, mic=${micDeviceId.ifEmpty { "default" }})")
        scope.launch {
            // Tear down anything left over from a previous session before
            // starting a new one — JS can race connect/disconnect during
            // reconnect, and a leaked Room keeps mics + sockets alive.
            disposeRoom()
            try {
                val r = LiveKit.create(activity.application, overrides = LiveKitOverrides())
                // Attach listeners *before* connect() so we don't miss any
                // events that fire during the handshake.
                attachListeners(r)
                r.connect(url, token, options = ConnectOptions())
                room = r
                // Apply preferred input device (if any) before publishing
                // the mic — the AudioRecord opened by setMicrophoneEnabled
                // picks up the ADM's current preferred device.
                applyPreferredInputDevice(r, micDeviceId)
                // Publish (and set initial mute) before announcing
                // "connected" so the JS layer sees a fully-set-up Room.
                // Failure to publish is non-fatal: the Room is up, the
                // agent just won't hear us.
                try {
                    r.localParticipant.setMicrophoneEnabled(!manualMode)
                    micMuted = manualMode
                    // Diagnostic (experiment 03 follow-up): observe what LiveKit's
                    // audio handler routed to once the mic track is live.
                    logAudioRouting("post-mic-enable")
                } catch (t: Throwable) {
                    Log.w(TAG, "setMicrophoneEnabled at connect failed: ${t.message}", t)
                    emit(
                        "error",
                        JSONObject()
                            .put("source", "audio")
                            .put("message", "mic publish failed: ${t.message ?: t.javaClass.simpleName}"),
                    )
                    micMuted = true
                }
                emit("connected", JSONObject().put("roomName", roomName))
            } catch (t: Throwable) {
                Log.w(TAG, "connect failed: ${t.message}", t)
                emit(
                    "error",
                    JSONObject()
                        .put("source", "livekit")
                        .put("message", t.message ?: t.javaClass.simpleName),
                )
                disposeRoom()
            }
        }
        return true
    }

    @JavascriptInterface
    fun disconnect() {
        Log.i(TAG, "disconnect()")
        scope.launch {
            disposeRoom()
            emit("disconnected", JSONObject().put("reason", "user"))
        }
    }

    @JavascriptInterface
    fun setMicMuted(muted: Boolean) {
        Log.i(TAG, "setMicMuted($muted)")
        scope.launch {
            val r = room ?: return@launch
            try {
                r.localParticipant.setMicrophoneEnabled(!muted)
                micMuted = muted
                emit("mic-state", JSONObject().put("muted", muted))
            } catch (t: Throwable) {
                Log.w(TAG, "setMicMuted failed: ${t.message}", t)
                emit(
                    "error",
                    JSONObject()
                        .put("source", "audio")
                        .put("message", "mic toggle failed: ${t.message ?: t.javaClass.simpleName}"),
                )
            }
        }
    }

    /**
     * Publish a UI control message to the worker over the LiveKit data
     * channel. Mirrors the Web SDK transport's publishControl: the React
     * UI calls this from the keyword-mode action buttons (Start / End /
     * Scrap / Redo / Replay / Abort) so the user can drive the keyword
     * pipeline without speaking. The JSON shape matches what the worker
     * expects on topic "voice-bridge": {"kind":"control","action":"<name>"}.
     */
    @JavascriptInterface
    fun publishControl(action: String) {
        Log.i(TAG, "publishControl($action)")
        scope.launch {
            val r = room ?: return@launch
            try {
                val json = JSONObject()
                    .put("kind", "control")
                    .put("action", action)
                    .toString()
                r.localParticipant.publishData(
                    data = json.toByteArray(Charsets.UTF_8),
                    reliability = DataPublishReliability.RELIABLE,
                    topic = "voice-bridge",
                )
            } catch (t: Throwable) {
                Log.w(TAG, "publishControl failed: ${t.message}", t)
            }
        }
    }

    /**
     * Enumerate hardware audio input devices for the Settings UI's
     * Android mic dropdown. Returns a JSON array of objects:
     *   [{ id: "<int>", type: <int>, typeName: string, productName: string, address: string }]
     *
     * - `id` is AudioDeviceInfo.getId() stringified — that's what gets
     *   stored in config.voice.androidMicDeviceId and looked up at
     *   connect-time. IDs are stable enough for built-in devices but
     *   change for hot-pluggable ones (BT/USB) on each reconnect; a
     *   stale id falls back to OS default at connect time.
     * - `typeName` is decoded from AudioDeviceInfo.TYPE_* constants so
     *   the JS side can render a label without an Android lookup table.
     */
    @JavascriptInterface
    fun listMicrophones(): String {
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val arr = JSONArray()
        for (d in am.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            arr.put(
                JSONObject()
                    .put("id", d.id.toString())
                    .put("type", d.type)
                    .put("typeName", audioDeviceTypeName(d.type))
                    .put("productName", d.productName?.toString() ?: "")
                    .put("address", d.address ?: ""),
            )
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun getStateJson(): String {
        return JSONObject()
            .put("connected", room != null)
            .put("micMuted", micMuted)
            .put("phase", "9.3")
            .toString()
    }

    /**
     * Best-effort tear-down. Called from MainActivity.onDestroy so we don't
     * leak a Room (and its mic + WebRTC sockets) past Activity destruction.
     */
    fun shutdown() {
        room?.let { r ->
            try { r.disconnect() } catch (_: Throwable) { /* best effort */ }
        }
        room = null
        micMuted = true
        eventsJob?.cancel()
        eventsJob = null
        scope.cancel()
    }

    private fun attachListeners(r: Room) {
        eventsJob?.cancel()
        eventsJob = scope.launch {
            r.events.collect { ev ->
                when (ev) {
                    is RoomEvent.Disconnected -> {
                        // SDK-initiated disconnect (server kick, network
                        // loss). User-initiated paths go through
                        // disposeRoom() which cancels this job before the
                        // event fires, so this branch only runs for
                        // unsolicited disconnects. Drop our refs so
                        // getStateJson reflects reality.
                        room = null
                        micMuted = true
                        emit(
                            "disconnected",
                            JSONObject().put("reason", ev.reason?.name ?: "unknown"),
                        )
                    }
                    is RoomEvent.Reconnecting -> emit("reconnecting", JSONObject())
                    is RoomEvent.Reconnected -> emit("reconnected", JSONObject())
                    is RoomEvent.TrackSubscribed -> {
                        // Diagnostic: the agent in livekit-agents cycles
                        // tracks between utterances (earcons / replies),
                        // and we want to know if any post-first-utterance
                        // track is failing to start playback. The SDK
                        // auto-plays subscribed audio, so we don't take
                        // any action — just log.
                        Log.i(
                            TAG,
                            "TrackSubscribed kind=${ev.track.kind} sid=${ev.publication.sid}",
                        )
                    }
                    is RoomEvent.TrackUnsubscribed -> {
                        Log.i(
                            TAG,
                            "TrackUnsubscribed kind=${ev.track.kind} sid=${ev.publications.sid}",
                        )
                    }
                    is RoomEvent.DataReceived -> {
                        // Worker → client messages on the LiveKit data
                        // channel: voice-state updates (e.g.
                        // {kind:"voice-state", armed:true} for the
                        // keyword-mode armed indicator). Mirrors how
                        // WebTransport's RoomEvent.DataReceived listener
                        // surfaces these to voice.ts. We parse here so
                        // the JS side gets a real object inside the
                        // envelope, matching WebTransport's emitted
                        // shape.
                        val topic = ev.topic ?: ""
                        val text = try {
                            String(ev.data, Charsets.UTF_8)
                        } catch (t: Throwable) {
                            Log.w(TAG, "DataReceived utf8 decode failed: ${t.message}")
                            return@collect
                        }
                        val message = try {
                            JSONObject(text)
                        } catch (t: Throwable) {
                            // Worker only ever sends JSON objects on this
                            // channel today; non-JSON is treated as a
                            // diagnostic and dropped silently rather than
                            // crashing the bridge.
                            Log.w(TAG, "DataReceived non-JSON on $topic: ${t.message}")
                            return@collect
                        }
                        emit(
                            "data",
                            JSONObject()
                                .put("topic", topic)
                                .put("message", message),
                        )
                    }
                    else -> {
                        // RoomEvent.Connected fires too but we already emit
                        // "connected" deterministically when r.connect()
                        // returns, to avoid sending duplicates.
                    }
                }
            }
        }
    }

    /**
     * Pin the WebRTC ADM to a specific hardware mic. Empty string means
     * "let the OS pick." Stale ids (e.g. a Bluetooth headset that's no
     * longer connected) silently fall back to the OS default — the user
     * can re-pick from Settings if they care.
     */
    private fun applyPreferredInputDevice(r: Room, micDeviceId: String) {
        if (micDeviceId.isEmpty()) return
        val adm = r.lkObjects.audioDeviceModule as? JavaAudioDeviceModule
        if (adm == null) {
            Log.w(TAG, "ADM is not JavaAudioDeviceModule; cannot setPreferredInputDevice")
            return
        }
        val targetId = micDeviceId.toIntOrNull()
        if (targetId == null) {
            Log.w(TAG, "androidMicDeviceId '$micDeviceId' not an int; ignoring")
            return
        }
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val match = am.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.id == targetId }
        if (match == null) {
            Log.i(TAG, "preferred mic id=$targetId not present; using OS default")
            return
        }
        try {
            adm.setPreferredInputDevice(match)
            Log.i(TAG, "preferred mic set: id=${match.id} type=${audioDeviceTypeName(match.type)} name=${match.productName}")
        } catch (t: Throwable) {
            Log.w(TAG, "setPreferredInputDevice failed: ${t.message}", t)
        }
    }

    /** Diagnostic: snapshot the current audio routing so we can see, in the
     *  real LiveKit flow, whether the SDK's audio handler routed capture to a
     *  Bluetooth headset (vs the built-in mic). Temporary — paired with the
     *  Bluetooth mic fix; remove once routing is confirmed. */
    @SuppressLint("MissingPermission")
    private fun logAudioRouting(label: String) {
        try {
            val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val comms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.communicationDevice else null
            @Suppress("DEPRECATION") val sco = am.isBluetoothScoOn
            Log.i(
                TAG,
                "audio routing [$label]: mode=${am.mode} scoOn=$sco commsDevice=" +
                    (comms?.let { "id=${it.id} ${audioDeviceTypeName(it.type)}" } ?: "null"),
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Log.i(
                    TAG,
                    "availableCommDevices: " +
                        am.availableCommunicationDevices.joinToString { "id=${it.id}/${audioDeviceTypeName(it.type)}" },
                )
            }
        } catch (t: Throwable) {
            Log.w(TAG, "logAudioRouting failed: ${t.message}")
        }
    }

    private fun audioDeviceTypeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in mic"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth (SCO)"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth (A2DP)"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired headset"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB device"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headset"
        AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB accessory"
        AudioDeviceInfo.TYPE_TELEPHONY -> "Telephony"
        AudioDeviceInfo.TYPE_FM_TUNER -> "FM tuner"
        AudioDeviceInfo.TYPE_TV_TUNER -> "TV tuner"
        AudioDeviceInfo.TYPE_DOCK -> "Dock"
        AudioDeviceInfo.TYPE_LINE_ANALOG -> "Analog line-in"
        AudioDeviceInfo.TYPE_LINE_DIGITAL -> "Digital line-in"
        AudioDeviceInfo.TYPE_REMOTE_SUBMIX -> "Remote submix"
        else -> "Type $type"
    }

    private fun disposeRoom() {
        eventsJob?.cancel()
        eventsJob = null
        room?.let { r ->
            try { r.disconnect() } catch (_: Throwable) { /* best effort */ }
        }
        room = null
        micMuted = true
    }

    private fun emit(type: String, payload: JSONObject) {
        val envelope = JSONObject()
            .put("type", type)
            .put("payload", payload)
            .toString()
        // window.__voiceBridge is set up by the JS NativeTransport in Phase
        // 9.4. Until then it's undefined and the && short-circuit no-ops.
        val js = "window.__voiceBridge && window.__voiceBridge.dispatch($envelope)"
        activity.runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    companion object {
        private const val TAG = "VoiceBridge"
    }
}
