package com.voiceagentbridge

import android.accessibilityservice.AccessibilityService
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * Captures a Volume-Up press to start/stop a voice turn while the screen is off.
 *
 * Why an AccessibilityService: it's the only mechanism that sees key events
 * BEFORE audio routing, so it works screen-off and isn't stolen by the
 * Bluetooth call-mode/SCO routing the way earbud taps and MediaSession volume
 * are (verified: in call mode a bud tap just bounces SCO; volume keys go to the
 * call stream). We filter key events only — no window content is read.
 *
 * Scope is deliberately narrow so normal volume control is untouched: we only
 * intercept Volume-Up, and only while voice is connected AND the screen is off.
 * Everything else (Volume-Down, screen-on, not connected) passes straight
 * through. The press is relayed through the same VoiceForegroundService
 * .onMediaButton("toggle") path the notification control uses, so voice.ts maps
 * it mode-aware (keyword → arm/commit; manual/vad → mic toggle).
 *
 * User must enable it once: Settings → Accessibility → Voice Bridge.
 */
class VoiceAccessibilityService : AccessibilityService() {

    private val TAG = "VoiceA11y"

    override fun onKeyEvent(event: KeyEvent): Boolean {
        // Only Volume-Up is ours; let every other key (incl. Volume-Down)
        // dispatch normally.
        if (event.keyCode != KeyEvent.KEYCODE_VOLUME_UP) return false
        if (!shouldIntercept()) return false

        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            Log.i(TAG, "volume-up (screen off, voice connected) → toggle turn")
            VoiceForegroundService.onMediaButton?.invoke("toggle")
        }
        // Consume DOWN, UP and repeats so the system volume UI doesn't appear
        // and the level doesn't change.
        return true
    }

    private fun shouldIntercept(): Boolean {
        if (!VoiceForegroundService.voiceConnected) return false
        val pm = getSystemService(POWER_SERVICE) as? PowerManager ?: return false
        return !pm.isInteractive // screen off
    }

    // Unused — we only filter key events.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
}
