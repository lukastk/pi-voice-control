package com.voiceagentbridge

import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

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
 * UI thread. Once we add real SDK calls (Phase 9.2) we'll marshal onto
 * Dispatchers.Main. Native → JS callbacks go via
 * webView.evaluateJavascript("window.__voiceBridge.dispatch(…)") which is
 * safe to call only from the UI thread.
 */
class VoiceBridge(
    @Suppress("unused") private val activity: AppCompatActivity,
    @Suppress("unused") private val webView: WebView,
) {
    @JavascriptInterface
    fun connect(
        url: String,
        token: String,
        roomName: String,
        identity: String,
        manualMode: Boolean,
    ): Boolean {
        // Avoid logging url/token — token is a JWT, treat as a credential.
        Log.i(TAG, "connect(room=$roomName, identity=$identity, manual=$manualMode) — skeleton, no-op")
        return false
    }

    @JavascriptInterface
    fun disconnect() {
        Log.i(TAG, "disconnect() — skeleton, no-op")
    }

    @JavascriptInterface
    fun setMicMuted(muted: Boolean) {
        Log.i(TAG, "setMicMuted($muted) — skeleton, no-op")
    }

    @JavascriptInterface
    fun getStateJson(): String {
        Log.i(TAG, "getStateJson() — skeleton")
        return """{"connected":false,"micMuted":true,"phase":"skeleton"}"""
    }

    companion object {
        private const val TAG = "VoiceBridge"
    }
}
