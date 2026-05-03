package com.voiceagentbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service of type microphone|mediaPlayback that keeps the WebView
 * process alive (and the CPU awake via PARTIAL_WAKE_LOCK) when the screen is
 * off. Without this, Android may pause the WebView's WebRTC PeerConnection
 * within a few minutes of screen-off, killing the voice link.
 *
 * Notification is intentionally low-importance and ongoing — the user can't
 * dismiss it (which is the point: it's the trust signal that this app holds
 * the mic) but it doesn't make sound.
 */
class VoiceForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var audioFocusRequest: AudioFocusRequest? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Voice Agent Bridge")
            .setContentText("Voice link active. Tap to return.")
            .setSmallIcon(R.drawable.ic_mic)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires the type passed at start time too.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Partial wake lock keeps the CPU running while the screen is off.
        // Released in onDestroy so we don't burn battery once the user
        // closes the app.
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "VoiceAgentBridge:VoiceLock",
        ).apply { acquire(/* no timeout */) }

        requestAudioFocus()
    }

    /**
     * Claim AudioFocus with USAGE_MEDIA so Android knows our app holds the
     * audio channel. We do NOT change AudioManager.mode — Chromium's
     * WebView routes its audio to STREAM_MUSIC regardless of mode, and
     * setting MODE_IN_COMMUNICATION silences STREAM_MUSIC, which means the
     * agent's TTS becomes inaudible (verified live: dumpsys audio showed
     * our service in MODE_IN_COMMUNICATION while the WebView's audio focus
     * stayed at USAGE_MEDIA → STREAM_MUSIC, producing total silence).
     *
     * This still holds an AudioFocus GAIN claim above the WebView's
     * Chromium-internal TRANSIENT_MAY_DUCK claim, which is the most we can
     * do from a WebView-based wrapper. Robust screen-off behaviour
     * ultimately needs the native LiveKit Android SDK so we can produce
     * the audio ourselves and avoid Chromium's policy entirely.
     */
    private fun requestAudioFocus() {
        val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager ?: return

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setAcceptsDelayedFocusGain(false)
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener { focusChange ->
                Log.i(TAG, "AudioFocus change: $focusChange (we keep going either way)")
            }
            .build()
        audioFocusRequest = request
        val result = audioManager.requestAudioFocus(request)
        Log.i(
            TAG,
            "requestAudioFocus(MEDIA) result=$result (1=granted, 0=failed, 2=delayed)",
        )
    }

    private fun releaseAudioFocus() {
        val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager ?: return
        audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        super.onDestroy()
        releaseAudioFocus()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Voice link",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Persistent notification while the voice link is active."
                    setShowBadge(false)
                    enableLights(false)
                    enableVibration(false)
                    setSound(null, null)
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    companion object {
        private const val TAG = "VoiceFgService"
        private const val CHANNEL_ID = "voice_agent_bridge"
        private const val NOTIFICATION_ID = 1
    }
}
