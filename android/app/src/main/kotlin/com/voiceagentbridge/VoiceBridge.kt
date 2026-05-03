package com.voiceagentbridge

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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
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
    ): Boolean {
        // Don't log url/token — token is a JWT credential.
        Log.i(TAG, "connect(room=$roomName, identity=$identity, manual=$manualMode)")
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
                // Publish (and set initial mute) before announcing
                // "connected" so the JS layer sees a fully-set-up Room.
                // Failure to publish is non-fatal: the Room is up, the
                // agent just won't hear us.
                try {
                    r.localParticipant.setMicrophoneEnabled(!manualMode)
                    micMuted = manualMode
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
                    else -> {
                        // RoomEvent.Connected fires too but we already emit
                        // "connected" deterministically when r.connect()
                        // returns, to avoid sending duplicates. Data events
                        // are wired in Phase 9.5.
                    }
                }
            }
        }
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
