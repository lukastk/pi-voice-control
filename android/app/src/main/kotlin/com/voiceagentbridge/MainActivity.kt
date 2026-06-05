package com.voiceagentbridge

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

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
    private lateinit var voiceBridge: VoiceBridge

    private lateinit var connectionError: View
    private lateinit var connectionErrorMessage: TextView

    // The picker dialog, tracked so a main-frame load failure doesn't stack
    // a second copy on top of one the user is already editing.
    private var pickerDialog: AlertDialog? = null

    // True once the in-flight page load has reported a main-frame error, so
    // onPageFinished (which still fires for the failed load) doesn't hide the
    // error overlay we just showed.
    private var currentLoadFailed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Volume rocker should control media volume (where the WebView's
        // audio plays via STREAM_MUSIC, regardless of MODE), not ringer.
        volumeControlStream = AudioManager.STREAM_MUSIC

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        webView = findViewById(R.id.webview)
        configureWebView()

        // Expose AndroidVoiceBridge to JS so the React app can use the
        // native LiveKit Android SDK in this wrapper instead of the
        // WebView's Web SDK. The WebView's audio path doesn't survive
        // screen-off — Chromium hardcodes USAGE_MEDIA → STREAM_MUSIC and
        // pauses on visibility change. Browsers and PWAs without this
        // bridge keep using the Web SDK.
        voiceBridge = VoiceBridge(this, webView)
        webView.addJavascriptInterface(voiceBridge, "AndroidVoiceBridge")

        // Long-press anywhere in the WebView changes the URL. WebView
        // doesn't expose long-press cleanly so we attach to the layout
        // backdrop instead.
        findViewById<View>(R.id.url_long_press_target).setOnLongClickListener {
            promptForUrl()
            true
        }

        connectionError = findViewById(R.id.connection_error)
        connectionErrorMessage = findViewById(R.id.connection_error_message)
        findViewById<Button>(R.id.connection_error_switch).setOnClickListener {
            promptForUrl()
        }
        findViewById<Button>(R.id.connection_error_retry).setOnClickListener {
            load(activeUrl())
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
        // Keep navigation in-app, and surface main-frame load failures (the
        // selected target's server being off / host unreachable) instead of
        // silently sitting on a blank page with no way to switch targets.
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                Log.i(TAG, "onPageStarted url=$url")
                // Deliberately do NOT reset currentLoadFailed here. WebView
                // fires onReceivedHttpError *before* committing the error-page
                // body, and that commit re-fires onPageStarted/onPageFinished
                // for the same URL — resetting here would wipe the failure flag
                // we just set and hide the overlay. The flag is reset in load()
                // when we intentionally start a fresh navigation instead.
            }

            // Transport-level failures: DNS, connection refused, timeout — the
            // host can't be reached at all.
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                Log.i(
                    TAG,
                    "onReceivedError mainFrame=${request.isForMainFrame} " +
                        "url=${request.url} code=${error.errorCode} desc=${error.description}",
                )
                if (!request.isForMainFrame) return
                handleMainFrameLoadFailure(
                    request.url?.toString().orEmpty(),
                    error.description?.toString().orEmpty(),
                )
            }

            // HTTP-level failures: the host answered, but with a 4xx/5xx — e.g.
            // `tailscale serve` returns 502 when the backend server is off.
            // WebView surfaces this as ERR_HTTP_RESPONSE_CODE_FAILURE and routes
            // it here, NOT to onReceivedError.
            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                Log.i(
                    TAG,
                    "onReceivedHttpError mainFrame=${request.isForMainFrame} " +
                        "url=${request.url} status=${errorResponse.statusCode}",
                )
                if (!request.isForMainFrame) return
                handleMainFrameLoadFailure(
                    request.url?.toString().orEmpty(),
                    "HTTP ${errorResponse.statusCode} ${errorResponse.reasonPhrase.orEmpty()}".trim(),
                )
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                Log.i(TAG, "onPageFinished url=$url failed=$currentLoadFailed")
                if (!currentLoadFailed) hideConnectionError()
            }
        }
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
        // Needed to route capture to a Bluetooth headset mic (SCO) on API 31+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            needed.add(Manifest.permission.BLUETOOTH_CONNECT)
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
        val active = activeUrl()
        if (active.isEmpty()) {
            promptForUrl()
            return
        }
        load(active)
    }

    /** Single entry point for loading a target URL: clears any error overlay
     *  and the failed flag first, so onPageFinished can hide the overlay on a
     *  clean load and onReceivedError can re-show it if this one also fails. */
    private fun load(url: String) {
        if (url.isEmpty()) {
            promptForUrl()
            return
        }
        currentLoadFailed = false
        hideConnectionError()
        webView.loadUrl(url)
    }

    /**
     * Handle a main-frame load failure (transport error or HTTP error status):
     * mark the load failed, show the connection-error overlay, and pop the
     * target picker so the user can switch — the whole point of the fix: a dead
     * selected target must never leave the app stuck with no way to reach
     * another one. The picker is only auto-opened when one isn't already
     * showing, so repeated failures (e.g. retrying onto another dead target)
     * don't stack dialogs.
     */
    private fun handleMainFrameLoadFailure(failedUrl: String, reason: String) {
        currentLoadFailed = true
        val target = failedUrl.ifEmpty { activeUrl() }
        connectionErrorMessage.text = buildString {
            append("Couldn't reach\n")
            append(target.ifEmpty { "the selected target" })
            if (reason.isNotEmpty()) append("\n\n($reason)")
            append("\n\nPick a different target below.")
        }
        connectionError.visibility = View.VISIBLE
        if (pickerDialog?.isShowing != true) promptForUrl()
    }

    private fun hideConnectionError() {
        connectionError.visibility = View.GONE
    }

    /**
     * Resolve which URL we should currently load. Reads KEY_ACTIVE_URL
     * first; if that's empty (fresh install or migration), seeds it
     * from the entry list, falling back to the legacy KEY_URL single-
     * string preference written by older builds. Empty string means
     * "no URL configured yet — prompt the user".
     */
    private fun activeUrl(): String {
        val saved = prefs.getString(KEY_ACTIVE_URL, "")?.trim().orEmpty()
        if (saved.isNotEmpty()) return saved
        val entries = loadEntries()
        if (entries.isNotEmpty()) {
            prefs.edit().putString(KEY_ACTIVE_URL, entries[0].url).apply()
            return entries[0].url
        }
        // Migrate legacy single-URL key written by pre-multi-URL builds.
        val legacy = prefs.getString(KEY_URL, "")?.trim().orEmpty()
        if (legacy.isNotEmpty()) {
            saveEntries(listOf(UrlEntry(deriveName(legacy), legacy)))
            prefs.edit().putString(KEY_ACTIVE_URL, legacy).apply()
            return legacy
        }
        return ""
    }

    /**
     * Multi-URL picker dialog. Shows:
     *   - a multiline EditText for the full list (one entry per line,
     *     "Name | URL"), so you can paste/edit a fresh list quickly;
     *   - a RadioGroup below it to pick which entry is currently
     *     active. The radio list re-renders on every text change so
     *     "what you'd save" is always visible. The active selection
     *     persists across edits when the URL is still in the list.
     *
     * On save we parse the text, persist the entry list as JSON, write
     * the active URL, and reload the WebView if the active URL changed.
     */
    private fun promptForUrl() {
        val initialEntries = loadEntries()
        val initialActive = prefs.getString(KEY_ACTIVE_URL, "")?.trim().orEmpty()
        val previousActiveUrl = if (webView.url != null) webView.url else null

        val padding = (resources.displayMetrics.density * 16).toInt()

        val editText = EditText(this).apply {
            inputType =
                InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setText(entriesToText(initialEntries))
            minLines = 4
            setHorizontallyScrolling(false)
            isVerticalScrollBarEnabled = true
        }

        val radioGroup = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }

        // Renders the radio list from a parsed entry list. Tries to
        // preserve the user's current radio selection across re-renders
        // (so editing other lines in the EditText doesn't lose your
        // active pick); falls back to the persisted active URL, then
        // first entry.
        fun renderRadios(parsed: List<UrlEntry>) {
            val previouslyCheckedUrl = run {
                val id = radioGroup.checkedRadioButtonId
                if (id == -1) initialActive
                else (radioGroup.findViewById<RadioButton>(id)?.tag as? String) ?: initialActive
            }
            radioGroup.removeAllViews()
            for (entry in parsed) {
                val rb = RadioButton(this).apply {
                    id = View.generateViewId()
                    text = "${entry.name} — ${entry.url}"
                    tag = entry.url
                    isChecked = entry.url == previouslyCheckedUrl
                }
                radioGroup.addView(rb)
            }
            if (radioGroup.checkedRadioButtonId == -1 && radioGroup.childCount > 0) {
                (radioGroup.getChildAt(0) as RadioButton).isChecked = true
            }
        }

        renderRadios(initialEntries)

        editText.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                renderRadios(parseEntries(s?.toString() ?: ""))
            }
        })

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding / 2, padding, 0)
        }

        val instructions = TextView(this).apply {
            text =
                "One entry per line, format: Name | URL\n\n" +
                    "Example:\n" +
                    "Mac | https://my-mac.tailnet.ts.net/\n" +
                    "Server | https://my-server.tailnet.ts.net/"
            textSize = 12f
            setPadding(0, 0, 0, padding / 2)
        }
        val activeLabel = TextView(this).apply {
            text = "Active:"
            setPadding(0, padding, 0, padding / 4)
        }

        container.addView(instructions)
        container.addView(
            editText,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        container.addView(activeLabel)
        container.addView(radioGroup)

        val scroll = ScrollView(this).apply { addView(container) }

        val dialog = AlertDialog.Builder(this)
            .setTitle("Voice Agent Bridge URLs")
            .setView(scroll)
            .setPositiveButton("Save", null)
            .setNegativeButton("Cancel", null)
            .create()

        // Override Save click ourselves so empty-list errors keep the
        // dialog open instead of dismissing on every press.
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val parsed = parseEntries(editText.text.toString())
                if (parsed.isEmpty()) {
                    Toast.makeText(
                        this,
                        "Add at least one URL — format: Name | URL",
                        Toast.LENGTH_SHORT,
                    ).show()
                    return@setOnClickListener
                }
                val checkedId = radioGroup.checkedRadioButtonId
                val checkedTag =
                    if (checkedId != -1) {
                        radioGroup.findViewById<RadioButton>(checkedId)?.tag as? String
                    } else null
                val newActive = checkedTag ?: parsed[0].url
                saveEntries(parsed)
                prefs.edit().putString(KEY_ACTIVE_URL, newActive).apply()
                // Reload on any switch, or whenever the error overlay is up —
                // re-selecting the same (now hopefully recovered) target should
                // still retry rather than leave the overlay stuck.
                if (newActive != previousActiveUrl || connectionError.visibility == View.VISIBLE) {
                    load(newActive)
                }
                dialog.dismiss()
            }
        }
        dialog.setOnDismissListener { pickerDialog = null }
        pickerDialog = dialog
        dialog.show()
    }

    private data class UrlEntry(val name: String, val url: String)

    /** Parse the EditText contents into entries. One per line; the
     *  separator is the first '|' in the line (URLs don't contain '|'
     *  so this is unambiguous). Lines without a name fall back to a
     *  hostname-derived name. Lines without a URL-shaped second half
     *  are dropped silently — the radio list reflects what's valid. */
    private fun parseEntries(text: String): List<UrlEntry> {
        return text.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapNotNull { line ->
                val pipe = line.indexOf('|')
                if (pipe >= 0) {
                    val name = line.substring(0, pipe).trim()
                    val url = line.substring(pipe + 1).trim()
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        UrlEntry(name.ifEmpty { deriveName(url) }, url)
                    } else null
                } else {
                    if (line.startsWith("http://") || line.startsWith("https://")) {
                        UrlEntry(deriveName(line), line)
                    } else null
                }
            }
    }

    private fun entriesToText(entries: List<UrlEntry>): String {
        return entries.joinToString("\n") { "${it.name} | ${it.url}" }
    }

    private fun loadEntries(): List<UrlEntry> {
        val raw = prefs.getString(KEY_URL_ENTRIES, null)
        if (!raw.isNullOrEmpty()) {
            return try {
                val arr = JSONArray(raw)
                (0 until arr.length()).map {
                    val obj = arr.getJSONObject(it)
                    UrlEntry(obj.optString("name"), obj.optString("url"))
                }.filter { it.url.isNotEmpty() }
            } catch (_: Throwable) {
                emptyList()
            }
        }
        return emptyList()
    }

    private fun saveEntries(entries: List<UrlEntry>) {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(JSONObject().put("name", e.name).put("url", e.url))
        }
        prefs.edit().putString(KEY_URL_ENTRIES, arr.toString()).apply()
    }

    private fun deriveName(url: String): String {
        return try {
            Uri.parse(url).host ?: url
        } catch (_: Throwable) {
            url
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Disconnect the native LiveKit Room and cancel its coroutine scope
        // before tearing down the WebView — otherwise the Room can outlive
        // the Activity and keep the mic + WebRTC sockets alive.
        voiceBridge.shutdown()
        stopService(Intent(this, VoiceForegroundService::class.java))
        webView.destroy()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    companion object {
        private const val TAG = "VoiceBridgeMain"
        private const val PREFS = "voice_agent_bridge"
        // Legacy single-URL pref written by older builds. Read once at
        // startup for migration into KEY_URL_ENTRIES; never written.
        private const val KEY_URL = "url"
        // JSON-encoded list of {name, url} entries.
        private const val KEY_URL_ENTRIES = "url_entries"
        // The currently-active URL — must match a `url` field in
        // KEY_URL_ENTRIES, otherwise the picker resets to the first.
        private const val KEY_ACTIVE_URL = "active_url"
        private const val KEY_BATTERY_PROMPT_SHOWN = "battery_prompt_shown"
        private const val REQ_RUNTIME = 1001
    }
}
