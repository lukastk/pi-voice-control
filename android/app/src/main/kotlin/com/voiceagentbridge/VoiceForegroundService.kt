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
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL

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
     * Claim a "phone-call-style" audio session so Android keeps the WebView
     * audio playing through screen-off.
     *
     * Why this and not USAGE_MEDIA: dumpsys audio shows that Chromium's
     * WebView requests its own AudioFocus on top of ours as
     * GAIN_TRANSIENT_MAY_DUCK — a weak type that the system aggressively
     * releases on visibility change. With our app in MODE_IN_COMMUNICATION
     * and a USAGE_VOICE_COMMUNICATION focus claim, Android treats the
     * whole app as an ongoing voice call (same pattern WhatsApp / Zoom /
     * Discord / Signal use), which suppresses the pause-on-screen-off
     * behaviour at a layer the WebView's policy can't override.
     *
     * Tradeoff: the volume rocker now controls the VOICE_CALL stream, not
     * MEDIA. We compensate in MainActivity by setting volumeControlStream
     * to STREAM_VOICE_CALL too. Speakerphone is forced on so output goes
     * to the loudspeaker by default (matching media-style UX), not the
     * earpiece (which is the MODE_IN_COMMUNICATION default).
     */
    private fun requestAudioFocus() {
        val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager ?: return

        // Take the app into VoIP/phone-call audio mode. The OS treats apps
        // in this mode as ongoing communication and doesn't pause them on
        // screen-off the way it does media-mode apps with weak focus.
        previousAudioMode = audioManager.mode
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        } catch (e: SecurityException) {
            Log.w(TAG, "setMode(IN_COMMUNICATION) denied: ${e.message}")
        }

        // Default communication-mode routing is the earpiece. Force the
        // loudspeaker so the user can leave the phone in their pocket and
        // still hear the agent (and Bluetooth audio still wins if a BT
        // headset is connected — that's handled by the OS, not us).
        try {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = true
        } catch (_: Throwable) {
            // ignore — some OEMs restrict this from non-system apps
        }

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
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
            "requestAudioFocus(VOICE_COMMUNICATION) result=$result (1=granted, 0=failed, 2=delayed)",
        )
    }

    private fun releaseAudioFocus() {
        val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager ?: return
        audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
        // Restore whatever audio mode the system had before we claimed it.
        try {
            audioManager.mode = previousAudioMode
        } catch (_: Throwable) {
            // ignore
        }
        try {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
        } catch (_: Throwable) {
            // ignore
        }
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
