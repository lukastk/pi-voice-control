package com.voiceagentbridge

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * THROWAWAY R&D harness (debug builds only) for experiment
 * _dev/experiments/03_android_bt_mic_routing.
 *
 * Exercises the raw Android audio capture APIs directly — no LiveKit — so we
 * can find the minimal recipe that actually routes capture to a Bluetooth
 * headset (AirPods). Ground truth = AudioRecord.getRoutedDevice(); we also
 * surface a live RMS level so a human can A/B (speak into AirPods vs phone).
 *
 * Strategies under test:
 *   A — AudioRecord.setPreferredDevice(bt)      (today's VoiceBridge approach)
 *   B — AudioManager.setCommunicationDevice(bt) (API 31+, the modern VoIP way)
 *   C — legacy startBluetoothSco() + MODE_IN_COMMUNICATION
 *
 * Whatever wins gets ported into VoiceBridge.applyPreferredInputDevice. This
 * file is deleted once the recipe is settled.
 */
class MicLabActivity : android.app.Activity() {

    private val TAG = "MicLab"
    private val SAMPLE_RATE = 16000

    private lateinit var am: AudioManager
    private lateinit var status: TextView
    private var record: AudioRecord? = null
    private var captureThread: Thread? = null
    @Volatile private var running = false
    @Volatile private var lastRms = 0.0
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        am = getSystemService(AUDIO_SERVICE) as AudioManager

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF101018.toInt())
            setPadding(24, 48, 24, 24)
        }
        fun btn(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label
            setOnClickListener { onClick() }
            root.addView(this)
        }

        TextView(this).apply {
            text = "Mic Lab — Bluetooth routing R&D"
            setTextColor(0xFFE6E6F0.toInt())
            textSize = 16f
            root.addView(this)
        }
        btn("List input devices") { showDevices() }
        btn("A: setPreferredDevice(BT)") { startCapture(Strategy.PREFERRED) }
        btn("B: setCommunicationDevice(BT)") { startCapture(Strategy.COMMS_DEVICE) }
        btn("C: legacy SCO + comms mode") { startCapture(Strategy.LEGACY_SCO) }
        btn("STOP") { stopCapture() }

        status = TextView(this).apply {
            setTextColor(0xFF9AC99A.toInt())
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(0, 24, 0, 0)
            gravity = Gravity.TOP
        }
        val scroll = ScrollView(this).apply { addView(status) }
        root.addView(scroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))

        setContentView(root)
        ensurePermissions()
        showDevices()
    }

    private fun ensurePermissions() {
        val need = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            need.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        val missing = need.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
    }

    private fun inputs(): List<AudioDeviceInfo> =
        am.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()

    private fun btInput(): AudioDeviceInfo? =
        inputs().firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }

    private fun showDevices() {
        val sb = StringBuilder("INPUT DEVICES (getDevices):\n")
        for (d in inputs()) {
            sb.append("  id=${d.id}  ${typeName(d.type)}  \"${d.productName}\"\n")
        }
        val btConnect = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        else true
        sb.append("BLUETOOTH_CONNECT granted: $btConnect\n")
        sb.append("BT SCO input present: ${btInput() != null}\n")
        Log.i(TAG, sb.toString())
        setStatus(sb.toString())
    }

    private enum class Strategy { PREFERRED, COMMS_DEVICE, LEGACY_SCO }

    @SuppressLint("MissingPermission")
    private fun startCapture(strategy: Strategy) {
        stopCapture()
        val bt = btInput()
        val header = StringBuilder("STRATEGY: $strategy\n")
        header.append("requested BT device: ${bt?.let { "id=${it.id} ${typeName(it.type)}" } ?: "NONE FOUND"}\n")

        // Pre-record routing.
        when (strategy) {
            Strategy.PREFERRED -> { /* applied to AudioRecord below */ }
            Strategy.COMMS_DEVICE -> {
                am.mode = AudioManager.MODE_IN_COMMUNICATION
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // setCommunicationDevice() requires a device from
                    // availableCommunicationDevices(), NOT getDevices().
                    val avail = am.availableCommunicationDevices
                    header.append("availableCommunicationDevices:\n")
                    for (d in avail) header.append("    id=${d.id} ${typeName(d.type)}\n")
                    val btc = avail.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                    val ok = if (btc != null) am.setCommunicationDevice(btc) else false
                    header.append("setCommunicationDevice(bt id=${btc?.id}) -> $ok\n")
                }
            }
            Strategy.LEGACY_SCO -> {
                am.mode = AudioManager.MODE_IN_COMMUNICATION
                @Suppress("DEPRECATION") am.startBluetoothSco()
                @Suppress("DEPRECATION") run { am.isBluetoothScoOn = true }
                header.append("startBluetoothSco() requested\n")
            }
        }

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val ar = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(minBuf * 2)
            .build()
        if (strategy == Strategy.PREFERRED && bt != null) {
            val ok = ar.setPreferredDevice(bt)
            header.append("setPreferredDevice -> $ok\n")
        }
        record = ar
        ar.startRecording()
        running = true
        Log.i(TAG, header.toString())

        val buf = ShortArray(minBuf)
        captureThread = thread(name = "miclab-capture") {
            while (running) {
                val n = ar.read(buf, 0, buf.size)
                if (n > 0) {
                    var sum = 0.0
                    for (i in 0 until n) { val s = buf[i].toDouble(); sum += s * s }
                    lastRms = sqrt(sum / n)
                }
            }
        }
        // Periodic UI/log readout of the GROUND TRUTH: what device the running
        // AudioRecord is actually pulling from.
        ui.post(object : Runnable {
            override fun run() {
                if (!running) return
                val routed = record?.routedDevice
                val comms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                    am.communicationDevice else null
                val level = (lastRms / 200.0).coerceIn(0.0, 1.0)
                val bars = "█".repeat((level * 24).toInt()).padEnd(24, '░')
                val txt = header.toString() +
                    "\n--- live ---\n" +
                    "routedDevice : ${routed?.let { "id=${it.id} ${typeName(it.type)}" } ?: "null"}\n" +
                    "commsDevice  : ${comms?.let { "id=${it.id} ${typeName(it.type)}" } ?: "null"}\n" +
                    "scoOn        : ${@Suppress("DEPRECATION") am.isBluetoothScoOn}\n" +
                    "mode         : ${modeName(am.mode)}\n" +
                    "level        : [$bars] ${lastRms.toInt()}\n"
                setStatus(txt)
                Log.i(TAG, "routed=${routed?.type?.let { typeName(it) }} rms=${lastRms.toInt()}")
                ui.postDelayed(this, 300)
            }
        })
    }

    @SuppressLint("MissingPermission")
    private fun stopCapture() {
        running = false
        try { captureThread?.join(500) } catch (_: Throwable) {}
        captureThread = null
        try { record?.stop() } catch (_: Throwable) {}
        try { record?.release() } catch (_: Throwable) {}
        record = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try { am.clearCommunicationDevice() } catch (_: Throwable) {}
        }
        @Suppress("DEPRECATION") try { am.stopBluetoothSco() } catch (_: Throwable) {}
        am.mode = AudioManager.MODE_NORMAL
    }

    override fun onDestroy() { stopCapture(); super.onDestroy() }

    private fun setStatus(s: String) = ui.post { status.text = s }

    private fun modeName(m: Int) = when (m) {
        AudioManager.MODE_NORMAL -> "NORMAL"
        AudioManager.MODE_IN_COMMUNICATION -> "IN_COMMUNICATION"
        AudioManager.MODE_IN_CALL -> "IN_CALL"
        else -> m.toString()
    }

    private fun typeName(type: Int) = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in mic"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth A2DP"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired headset"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB device"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB headset"
        AudioDeviceInfo.TYPE_TELEPHONY -> "Telephony"
        else -> "type=$type"
    }
}
