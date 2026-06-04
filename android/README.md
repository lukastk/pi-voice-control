# Voice Agent Bridge — Android wrapper

A thin native shell around the web UI so voice keeps running with the screen off (Android Chrome PWAs cannot run audio in the background; this can).

The whole app is roughly 250 lines of Kotlin: one `Activity` + one `Service`, a WebView pointed at your Tailscale URL, and a `microphone | mediaPlayback` foreground service that holds a `PARTIAL_WAKE_LOCK`.

## Build

You need Android Studio (Hedgehog or newer) with the Android SDK 34. Easiest:

1. Open Android Studio → `File` → `Open` → pick the `android/` directory in this repo.
2. Wait for Gradle sync.
3. Plug in your phone with USB debugging enabled.
4. Click **Run** (or `Shift+F10`).

The first launch prompts you to enter at least one URL — paste the `https://<tailnet>.ts.net/` from `bin/tailscale-serve.sh`. The list persists in SharedPreferences along with the currently active selection. **Long-press the top-right corner of the WebView** to open the URLs dialog later — useful for keeping multiple servers (e.g. Mac + remote) and switching between them. Format: one entry per line, `Name | URL`. Tap a radio entry to make it the active URL the next time you save.

If the active target is unreachable (its server is off, or Tailscale can't resolve it), the WebView would otherwise sit on a blank page. Instead the app shows a connection-error overlay (with **Switch target** / **Retry** buttons) and automatically opens the URLs dialog so you can pick another target — you're never stuck on a dead selection.

### Or from the command line

```bash
cd android
./gradlew installDebug          # builds + installs the debug APK over adb
./gradlew assembleRelease       # produces app/build/outputs/apk/release/app-release-unsigned.apk
```

If `gradlew` isn't present, run `gradle wrapper` once to generate it (or open in Android Studio, which does it for you).

## First run

You'll be asked to grant:

1. **Microphone** — required for voice input. Pick "Allow only while using the app" — the foreground service keeps the mic privilege alive even when the WebView is in the background.
2. **Notifications** (Android 13+) — required to display the foreground-service notification, which is what guarantees the OS won't kill the WebView when you lock the phone.

After permissions are granted, paste your URL. Connect voice in the UI. Then lock the phone — the persistent notification stays visible, voice continues. Tap the notification to bring the app back.

## What it actually does

- `MainActivity` hosts a full-screen `WebView`. JS, DOM storage, autoplay are on; file access is off.
- `WebChromeClient.onPermissionRequest` grants `RESOURCE_AUDIO_CAPTURE` so the page's `getUserMedia({audio:true})` works without a second permission flow.
- `VoiceForegroundService` is started before the WebView loads (`startForegroundService(...)` on Android 8+). Its notification is non-dismissable, low-priority, silent. Service type is `microphone | mediaPlayback` (Android 14 requires the type both in the manifest and in the `startForeground(..., type)` call). It acquires `PowerManager.PARTIAL_WAKE_LOCK` to keep the CPU awake; releases on `onDestroy`.
- WebRTC inside the WebView lives in the same OS process as the foreground service, so Android's "doze mode" / aggressive background kill heuristics leave it alone.

## Caveats

- **Bluetooth audio**: Android routes mic + speaker through whichever output device is active. AirPods or any BT headset will work; mid-call output device switching also works because the WebView uses standard system audio.
- **Tailscale must be running** on the phone with the same Tailnet, or the URL won't resolve. Tailscale's auto-cert only works inside the tailnet.
- **Doze mode after long sleep**: if you put the phone in your pocket for hours and Android decides nothing is happening, it can still throttle. The foreground service prevents this for "active" use but won't override `Battery Optimization`. The app prompts on first launch to mark itself as battery-optimisation-exempt — accept that prompt. If you skipped it: Settings → Apps → Voice Bridge → Battery → "Unrestricted".

## Why a foreground service vs. a regular WebView?

A regular Android Chrome PWA — even one installed via "Add to Home screen" — is a Chrome tab under the hood. When the screen turns off, Chrome aggressively pauses tabs to save battery. WebRTC PeerConnections die within a few minutes. There is no Chrome flag for "keep tab alive".

A native app with a typed foreground service is the only sanctioned way to keep WebRTC running in the background on modern Android. This wrapper is the smallest possible app that does that.
