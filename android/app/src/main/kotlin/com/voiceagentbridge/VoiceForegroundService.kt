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
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat as MediaNotificationCompat

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
    private var mediaSession: MediaSessionCompat? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        setupMediaSession()

        val notification = buildNotification()

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
     * Media session so earbud taps (media buttons) and the notification /
     * lock-screen play-pause control drive the voice turn. The session is kept
     * active while the service runs; button events are forwarded to whatever
     * listener VoiceBridge has registered (which relays them to the web UI).
     */
    private fun setupMediaSession() {
        val ms = MediaSessionCompat(this, "VoiceBridge")
        ms.setCallback(object : MediaSessionCompat.Callback() {
            // Transport commands from the system / lock-screen controls.
            override fun onPlay() = fireMediaButton("toggle")
            override fun onPause() = fireMediaButton("toggle")
            override fun onSkipToNext() = fireMediaButton("next")
            override fun onSkipToPrevious() = fireMediaButton("prev")

            // Raw hardware/Bluetooth media keys (earbud taps). Consume the
            // ones we map so the default decode doesn't also fire onPlay/onPause.
            override fun onMediaButtonEvent(mediaButtonEvent: Intent): Boolean {
                val ke: KeyEvent? =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                    }
                if (ke != null && ke.action == KeyEvent.ACTION_DOWN && ke.repeatCount == 0) {
                    when (ke.keyCode) {
                        KeyEvent.KEYCODE_HEADSETHOOK,
                        KeyEvent.KEYCODE_MEDIA_PLAY,
                        KeyEvent.KEYCODE_MEDIA_PAUSE,
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { fireMediaButton("toggle"); return true }
                        KeyEvent.KEYCODE_MEDIA_NEXT -> { fireMediaButton("next"); return true }
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { fireMediaButton("prev"); return true }
                    }
                }
                return super.onMediaButtonEvent(mediaButtonEvent)
            }
        })
        ms.isActive = true
        mediaSession = ms
        // Start idle: PAUSED → the system media control shows ▶️ ("start a
        // turn"). setMediaPlaying(true) flips it to ⏸️ while a turn is active.
        setMediaPlaying(false)
    }

    /**
     * Reflect the live turn state in the media control: PLAYING (⏸️, "stop")
     * while a turn is active, PAUSED (▶️, "start") while idle. Driven from the
     * web UI via ACTION_SET_ACTIVE so the icon always matches reality.
     */
    private fun setMediaPlaying(playing: Boolean) {
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE,
                )
                .setState(
                    if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                    PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                    1f,
                )
                .build(),
        )
    }

    private fun fireMediaButton(action: String) {
        Log.i(TAG, "media button -> $action")
        onMediaButton?.invoke(action)
    }

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPi = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // No explicit action button: the single play/pause control is rendered
        // by the system from the MediaSession's PlaybackState (driven by
        // setMediaPlaying). Adding our own button as well produced a duplicate,
        // mis-ordered control.
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Voice Agent Bridge")
            .setContentText("Play/pause to start or stop a turn.")
            .setSmallIcon(R.drawable.ic_mic)
            .setContentIntent(contentPi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setStyle(
                MediaNotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken),
            )
            .build()
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

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_SET_ACTIVE) {
            setMediaPlaying(intent.getBooleanExtra(EXTRA_ACTIVE, false))
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        mediaSession?.let {
            it.isActive = false
            it.release()
        }
        mediaSession = null
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
        const val ACTION_SET_ACTIVE = "com.voiceagentbridge.action.SET_ACTIVE"
        const val EXTRA_ACTIVE = "active"

        /**
         * Set by VoiceBridge to relay media-button actions ("toggle" / "next"
         * / "prev") from earbud taps and the notification control into the web
         * UI. Same process, so a plain callback suffices; VoiceBridge clears it
         * on shutdown to avoid retaining the Activity.
         */
        @Volatile
        var onMediaButton: ((String) -> Unit)? = null
    }
}
