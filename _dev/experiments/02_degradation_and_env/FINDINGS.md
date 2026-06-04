# 02 — degradation & environment: FINDINGS

**Status:** done (2026-06-04). Run env: mymain (the real deployment, server under supervisord) + macbook.

## What we learned (affects production design)

- **`sesh` is NOT on the server's PATH under supervisord on mymain.** The `bun server/src/main.ts` process's PATH is:
  ```
  ~/.bun/bin:~/.nvm/versions/node/v25.6.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:~/.bun/bin:~/.local/bin:…
  ```
  `~/go/bin` (where `sesh` lives, `/home/lukastk/go/bin/sesh`) is **absent**. A naive `bin:"sesh"` default would `ENOENT` and silently no-op on the actual deployment.
  → **The `sesh.bin` config MUST default to / be set to an absolute path.** mymain: `/home/lukastk/go/bin/sesh`. macbook: `sesh` is on PATH, but an absolute `/Users/lukas/go/bin/sesh` is safer everywhere.
- **Failure modes are clean and catchable:**
  - Binary missing → `ENOENT` (Node `execFile` rejects) — catch → no-op/fallback.
  - Daemon down / bad socket → exit 1 + clear stderr — catch → no-op/fallback.
- **Daemon on mymain is healthy** (machine `mymain`, 83 sessions, 5 peers). `~/go/bin/sesh list --agent pi --json` → `[]` (no registered pi sessions there yet — same bare-pi situation as macbook).
- **No `--machine` filter needed** for correctness (uuid join drops non-local records); could add later purely to trim payload.

## Production implications

- Add `sesh: { enabled: boolean; bin: string }` to config. **Document that `bin` should be absolute** and set it in mymain's `~/.config/voice-agent-bridge/config.json` to `/home/lukastk/go/bin/sesh`.
- Both the enrichment (Phase 1) and the spawn (Phase 2) must treat any sesh exec failure as "sesh unavailable" → Phase 1 returns no enrichment, Phase 2 falls back to the existing bare-`pi` spawn. Never let a sesh hiccup break session discovery or spawning.

## Artifacts
- Inline probe (pushed to mymain as `/tmp/exp02-env.sh`, not retained) — checked the server process PATH via `/proc/<pid>/environ` and resolved `sesh` against it.
