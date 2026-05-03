package com.voiceagentbridge

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Single-Activity host for the Voice Agent Bridge web UI.
 *
 * Hosts a full-screen WebView pointed at the user's Tailscale-exposed
 * https://<tailnet>/ URL. Spawns a foreground service of type
 * microphone|mediaPlayback before loading so WebRTC keeps running with the
 * screen off.
 *
 * The URL is stored in SharedPreferences. First launch (or any time the URL
 * is empty) prompts via a dialog. Long-press on the WebView to change it
 * later — useful when your Tailscale Funnel hostname changes.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var prefs: SharedPreferences

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        webView = findViewById(R.id.webview)
        configureWebView()

        // Long-press anywhere in the WebView changes the URL. WebView
        // doesn't expose long-press cleanly so we attach to the layout
        // backdrop instead.
        findViewById<View>(R.id.url_long_press_target).setOnLongClickListener {
            promptForUrl()
            true
        }

        ensurePermissionsAndStart()
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.webViewClient = WebViewClient() // keep navigation in-app
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    // The page can ask for VIDEO_CAPTURE etc; we only want
                    // to grant audio-related resources.
                    val allowed = request.resources.filter { resource ->
                        resource == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    }.toTypedArray()
                    if (allowed.isNotEmpty()) request.grant(allowed) else request.deny()
                }
            }
        }
    }

    private fun ensurePermissionsAndStart() {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            // Already had everything granted from a previous install — no
            // onRequestPermissionsResult callback will fire, so prompt for
            // the battery exemption here too.
            maybePromptBatteryOptimizationExemption()
            startForegroundServiceAndLoad()
        } else {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_RUNTIME)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_RUNTIME) {
            // Any not-granted result is the user's choice — load anyway,
            // but voice obviously won't work without RECORD_AUDIO.
            maybePromptBatteryOptimizationExemption()
            startForegroundServiceAndLoad()
        }
    }

    /**
     * Doze mode can throttle even our microphone-typed foreground service
     * after ~30 min of screen-off idle. The system-settings shortcut at
     * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS lets the user mark the
     * app as exempt — symptoms before exempt: voice "works until it
     * doesn't" after a long screen-off. Symptoms after: works for hours.
     *
     * Only prompted once per install since the system intent is mildly
     * annoying. Re-trigger via long-press URL → "battery" if we add that.
     */
    @SuppressLint("BatteryLife")
    private fun maybePromptBatteryOptimizationExemption() {
        if (prefs.getBoolean(KEY_BATTERY_PROMPT_SHOWN, false)) return
        val pm = getSystemService(POWER_SERVICE) as? PowerManager ?: return
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            prefs.edit().putBoolean(KEY_BATTERY_PROMPT_SHOWN, true).apply()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Keep voice running with screen off")
            .setMessage(
                "Android may throttle background audio after ~30 minutes of " +
                    "screen-off. Allow Voice Bridge to ignore battery " +
                    "optimisation so voice keeps working for hours.",
            )
            .setPositiveButton("Settings") { _, _ ->
                val intent = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                )
                try {
                    startActivity(intent)
                } catch (_: Throwable) {
                    // some OEMs route this to a different settings page
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
                prefs.edit().putBoolean(KEY_BATTERY_PROMPT_SHOWN, true).apply()
            }
            .setNegativeButton("Skip") { _, _ ->
                prefs.edit().putBoolean(KEY_BATTERY_PROMPT_SHOWN, true).apply()
            }
            .setCancelable(false)
            .show()
    }

    private fun startForegroundServiceAndLoad() {
        val intent = Intent(this, VoiceForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        loadConfiguredUrl()
    }

    private fun loadConfiguredUrl() {
        val url = prefs.getString(KEY_URL, "")?.trim().orEmpty()
        if (url.isEmpty()) {
            promptForUrl()
            return
        }
        webView.loadUrl(url)
    }

    private fun promptForUrl() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.getString(KEY_URL, "https://"))
            setSelection(text.length)
        }
        AlertDialog.Builder(this)
            .setTitle("Voice Agent Bridge URL")
            .setMessage(
                "Enter the HTTPS URL the bin/tailscale-serve.sh script printed " +
                    "(e.g. https://your-mac.tailnet.ts.net/).",
            )
            .setView(input)
            .setPositiveButton("Connect") { _, _ ->
                val url = input.text.toString().trim()
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    prefs.edit().putString(KEY_URL, url).apply()
                    webView.loadUrl(url)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopService(Intent(this, VoiceForegroundService::class.java))
        webView.destroy()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    companion object {
        private const val PREFS = "voice_agent_bridge"
        private const val KEY_URL = "url"
        private const val KEY_BATTERY_PROMPT_SHOWN = "battery_prompt_shown"
        private const val REQ_RUNTIME = 1001
    }
}
