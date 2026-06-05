# Experiments plan

Throwaway prototyping for pi-voice-control. Each experiment is a numbered subdirectory under `_dev/experiments/`. The only deliverable is **learnings** — write them in the experiment's `FINDINGS.md` and summarize under the experiment's "Findings" section here. Experiment code is throwaway; rewrite in the real source once confident.

Status legend: `todo` · `in progress` · `done` · `skipped`.

---

## Group A — sesh ↔ pi-voice-control integration

Enrich the session picker with sesh metadata, and spawn voice sessions through sesh. Run env: macbook (live `sesh-daemon`, `tmux -L mysystem`, pi sockets in `/tmp/pi-rpc-sockets/`).

### `00_sesh_query_and_join`

**Status:** done (2026-06-04)

**Questions** (Phase 1 linchpin — does the metadata join actually work?)
- Does `sesh list --agent pi --json` enumerate *live* pi sessions, and is `record.uuid` exactly the basename of that session's `<uuid>.sock` in `/tmp/pi-rpc-sockets/`? (The whole join assumes `PiSession.sessionId === record.uuid`.)
- What's the exact JSON shape returned, and which fields are reliably populated for a live pi session (name, turnStatus, cwd, tmux, tags, contextPct, summary)?
- Do **bare** pi sessions (started outside sesh) appear in `sesh list --agent pi`, or only sesh-created ones? → characterizes the fallback path.
- Latency of `sesh list` (we'd call it every 2s poll), and behaviour when the daemon is unreachable.

**Deliverable**
- A probe script + a recorded real JSON record, the confirmed join key, and the fallback characterization.

**Findings** — full writeup in [`00_sesh_query_and_join/FINDINGS.md`](00_sesh_query_and_join/FINDINGS.md)
- Join key confirmed: a pi session's rpc `getState.sessionId` == socket basename == `sesh.uuid`. Join on `PiSession.sessionId === record.uuid`.
- `sesh list --agent pi --json` ≈ 55–60 ms (fine for the 2 s poll). Fields we consume: `uuid, name, machine, cwd, turnStatus, contextPct, tags[], summary, tmux{…}`.
- **Bare pi sessions don't appear in sesh** → enrichment is best-effort with fallback to today's display.
- Daemon unreachable → exit 1 + stderr; binary missing → ENOENT. Both catchable → degrade to empty enrichment. No `--machine` filter needed (uuid join drops remote records).

---

### `01_sesh_spawn_pi`

**Status:** done (2026-06-04)

**Questions** (Phase 2 linchpin — can voice spawn via sesh deterministically?)
- `sesh new --agent pi --cwd <dir> --no-launch --json` → confirm it returns `{uuid, launch}`; capture the exact `launch` shell-command string (does it `cd`, set a title, pass `--session-id`, model flags?).
- Run that `launch` in `tmux -L mysystem new-window -t voice-bridge-pi` — does a socket named exactly `<uuid>.sock` appear, and is it dial-able over the pi-rpc protocol? How is `launch` best executed (`sh -c`?).
- After spawn, does `sesh list --agent pi --json` show the new session with the correct tmux locator + cwd + tag?
- Compare with variant A (`sesh new --target mysystem:voice-bridge-pi`): does it emit the uuid on stdout? (Expected: no.) Confirm variant B (`--no-launch` + run ourselves) is the deterministic choice.
- Does `--tag voice` stick? Does omitting `--name` give a sensible auto-name?

**Deliverable**
- A spawn probe script, the captured `launch` format, and confirmation of the deterministic `<uuid>.sock` wait.

**Findings** — full writeup in [`01_sesh_spawn_pi/FINDINGS.md`](01_sesh_spawn_pi/FINDINGS.md)
- `sesh new … --no-launch --json` → `{uuid, launch}`; `launch` = `mkdir -p '<cwd>' && cd '<cwd>' && SESH_SESSION_ID='<uuid>' pi '--session-id' '<uuid>'`.
- Running `launch` as a tmux window command → `<uuid>.sock` appears ~3.5 s, dial-able; deterministic per-uuid wait works (replaces today's snapshot-diff).
- Registers cleanly: `tags:["voice"]` stick, tmux locator populated, `name:""` (omitted `--name` → AutoRename later). **Positive join confirmed**: socket basename === uuid.
- Variant A (`--target`) does **not** emit the uuid → variant B chosen. Killing a session leaves a **stale socket** (ECONNREFUSED) → relies on the poller's existing stale cleanup. `sesh delete` removes the record only.

---

### `02_degradation_and_env`

**Status:** done (2026-06-04)

**Questions** (robustness — integration must never harden voice into a sesh dependency)
- Where does `sesh` resolve from for the pi-voice-control server process under **supervisord** on mymain (is `~/go/bin` on its PATH)? Determine the right `sesh.bin` (likely an absolute path).
- Graceful degradation: behaviour/timing when `sesh` binary is missing or the daemon socket is down — confirm a clean error we can catch into a no-op (Phase 1) / fallback-to-bare-pi (Phase 2).
- Should `sesh list` be scoped to the local machine (`--machine`)? Confirm remote records simply don't match local sockets (uuid join), so no explicit filter is strictly needed.

**Deliverable**
- The resolved `sesh.bin` value for mymain, and the confirmed failure modes + timings.

**Findings** — full writeup in [`02_degradation_and_env/FINDINGS.md`](02_degradation_and_env/FINDINGS.md)
- **`sesh` is NOT on the server's PATH under supervisord on mymain** (`~/go/bin` absent) → `sesh.bin` must be **absolute** (`/home/lukastk/go/bin/sesh`). A `bin:"sesh"` default would silently no-op on the real deployment.
- Failures are catchable: binary missing → ENOENT; daemon down → exit 1 + stderr. Phase 1 → empty enrichment; Phase 2 → fall back to bare-`pi` spawn.
- No `--machine` filter needed for correctness. mymain daemon healthy.

---

## Group B — Android Bluetooth mic routing

Selecting a Bluetooth (AirPods) mic in the Android app doesn't work — capture stays on the built-in mic. Suspected causes: no `BLUETOOTH_CONNECT` permission, and routing via `setPreferredInputDevice` (a hint) which never starts Bluetooth SCO. Run env: physical Android phone over USB + AirPods, human-in-the-loop (Lukas).

### `03_android_bt_mic_routing`

**Status:** done (2026-06-05)

**Questions**
- Does `getDevices(GET_DEVICES_INPUTS)` list the AirPods SCO mic with vs without `BLUETOOTH_CONNECT` granted?
- Which routing recipe makes `AudioRecord.getRoutedDevice()` == AirPods AND registers input level when speaking into them?
  - A: `AudioRecord.setPreferredDevice(bt)` (today's approach).
  - B: `AudioManager.setCommunicationDevice(bt)` (API 31+).
  - C: legacy `startBluetoothSco()` + `MODE_IN_COMMUNICATION`.
- Does it require `MODE_IN_COMMUNICATION`? Any interaction with the foreground service / LiveKit AudioSwitchHandler?

**Method**
- A throwaway debug-only `MicLabActivity` (in `app/src/debug/`) that exercises raw Android audio APIs (no LiveKit), shows live routed-device + RMS level + comms/SCO state on screen and in logcat (tag `MicLab`). A/B by speaking into AirPods vs phone. Lab code is throwaway; the winning recipe gets ported into `VoiceBridge.applyPreferredInputDevice`.

**Findings** — full writeup in [`03_android_bt_mic_routing/FINDINGS.md`](03_android_bt_mic_routing/FINDINGS.md)
- BT mic capture needs: `BLUETOOTH_CONNECT` permission + `MODE_IN_COMMUNICATION` + `setCommunicationDevice(dev)` where `dev` comes from **`availableCommunicationDevices`** (NOT `getDevices` — ids differ). Measured working (rms→2571, routed=Bluetooth SCO).
- Today's `setPreferredDevice(getDevices BT)` is the bug: reports routed=BT but rms flat 0 (SCO never activated). `getRoutedDevice()` alone is a misleading signal.
- Production fix: add `BLUETOOTH_CONNECT` (main manifest + runtime). LiveKit's AudioSwitchHandler may then auto-route — test the real flow first; port the explicit recipe only if needed.

---

## Resolved decisions (2026-06-04)

- **Scope:** Phase 1 (enrich discovery) + Phase 2 (spawn via sesh). Phase 3 (daemon Watch stream, cross-machine) deferred.
- **Source of truth:** the pi socket dir stays the liveness truth; sesh is additive identity/metadata + the spawn path. Voice must degrade gracefully if sesh is unavailable.
- **Join key — VALIDATED (`00`+`01`):** `PiSession.sessionId` (socket basename) `=== sesh record.uuid`. Holds at the protocol level (rpc `getState.sessionId`) and end-to-end for a sesh-created session.
- **Spawn variant — VALIDATED (`01`):** `sesh new … --no-launch --json` → voice runs the returned `launch` string in its tmux window → waits for the specific `<uuid>.sock`. Variant A (`--target`) rejected: it doesn't emit the uuid.
- **`sesh.bin` must be absolute (`02`):** under supervisord on mymain, `~/go/bin` isn't on the server PATH. Default the config to an absolute path; set mymain's to `/home/lukastk/go/bin/sesh`.
- **CLI over gRPC:** `sesh list`/`sesh new` CLI (≈57 ms) is fast enough; no gRPC bindings needed. Revisit only if latency bites.
- **Stale sockets:** killing a sesh session leaves a dead socket file; rely on the poller's existing stale-socket cleanup (no new code).

## Still to decide

- Whether voice-spawned sessions pass `--name <folder-basename>` (readable immediately, disables sesh AutoRename) or omit `--name` (sesh auto-names after the first turn; picker falls back to cwd basename meanwhile). Lean: omit `--name`.
