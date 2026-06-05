# 03 — Android Bluetooth mic routing: FINDINGS

**Status:** done (2026-06-05). Device: Pixel 9 (Android 15, API 35), buds: Nothing Ear (a). Human-in-the-loop (Lukas). Lab: a throwaway debug `MicLabActivity` exercising raw Android audio APIs (no LiveKit), reading `AudioRecord.getRoutedDevice()` + live RMS.

## The recipe that works (ground truth, measured)

To capture from a Bluetooth headset mic on Android 12+:

1. Hold **`BLUETOOTH_CONNECT`** runtime permission. Without it, BT routing silently fails. (The SCO input device *is* still enumerated by `getDevices()` without it — enumeration ≠ routing.)
2. `audioManager.mode = MODE_IN_COMMUNICATION`.
3. Pick the BT device from **`audioManager.availableCommunicationDevices`** — NOT from `getDevices(GET_DEVICES_INPUTS)`. **The ids differ** (lab saw getDevices id `9146` vs availableCommunicationDevices id `9141` for the same buds), which is why passing the getDevices one fails.
4. `audioManager.setCommunicationDevice(btDevice)` → returns `true`, starts SCO, routes both directions.

Measured: `routedDevice = Bluetooth SCO`, rms climbed from ~1 (idle) to **2571** while speaking into the buds. Lukas confirmed perceptually it's the earbud mic.

## What does NOT work

- **Strategy A — `AudioRecord.setPreferredDevice(btFromGetDevices)`** (this is exactly what production `VoiceBridge.applyPreferredInputDevice` does today): returns `true` and `getRoutedDevice()` even *reports* "Bluetooth SCO" — but **rms stays flat 0** (309→ wait, 206 samples all 0). The SCO link is never activated, so it's silence. `getRoutedDevice()` is a misleading signal here; only the audio level reveals the truth. This fully explains the bug report.
- **Strategy B with the wrong device source** — `setCommunicationDevice(btFromGetDevices)` returns `false`. Must use `availableCommunicationDevices`.
- Strategy C (legacy `startBluetoothSco`) not needed — deprecated on API 31+; B is the modern replacement.

## Implications for the production fix

1. **Add `BLUETOOTH_CONNECT`** to the *main* manifest (currently only in the debug overlay) and request it at runtime in `MainActivity` alongside `RECORD_AUDIO`.
2. Routing: the app uses LiveKit, whose default `AudioSwitchHandler` is *designed* to call `setCommunicationDevice`→BT when permitted — so the missing permission alone may be the whole bug (LiveKit auto-routes to the only BT headset). **Test the real voice flow with just the permission first.** If an explicit dropdown selection must be honored beyond AudioSwitch's auto-priority, port the Strategy-B recipe into `applyPreferredInputDevice` (use `availableCommunicationDevices` + `setCommunicationDevice` for BT-type devices; keep `setPreferredInputDevice` for wired/USB/built-in).
3. Open question for the port: timing/conflict with LiveKit's AudioSwitchHandler (mode is only `IN_COMMUNICATION` once the mic track starts). Resolve in a follow-up real-app test (experiment 04 if needed).

## Artifacts
- `android/app/src/debug/java/com/voiceagentbridge/MicLabActivity.kt` + `android/app/src/debug/AndroidManifest.xml` — the throwaway lab (debug builds only; delete once the production fix lands). Launch: `adb shell am start -n com.voiceagentbridge.debug/com.voiceagentbridge.MicLabActivity`.
