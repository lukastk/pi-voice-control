import { useEffect, useMemo, useState } from "react";
import { api, type Config, type ElevenLabsVoice } from "../api.ts";
import {
  listAndroidMicrophones,
  type AndroidMicrophone,
} from "../native-transport.ts";
import {
  STT_MODELS,
  STT_LANGUAGES,
  TTS_MODELS,
  OPENAI_VOICES,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  STT_DEFAULT_MODEL,
} from "../voiceModels.ts";

type Props = {
  config: Config | null;
  voiceConnected: boolean;
  onReconnect: () => Promise<void>;
};

export function SettingsTab({ config, voiceConnected, onReconnect }: Props) {
  const [defaultFolder, setDefaultFolder] = useState<string>("");
  const [tmuxSocket, setTmuxSocket] = useState<string>("");
  const [spawnIfMissing, setSpawnIfMissing] = useState<boolean>(true);
  const [spawnTmuxSession, setSpawnTmuxSession] = useState<string>("");

  const [earconsEnabled, setEarconsEnabled] = useState(true);
  const [earconOver, setEarconOver] = useState(true);
  const [earconCopy, setEarconCopy] = useState(true);
  const [earconOut, setEarconOut] = useState(true);
  const [earconVolume, setEarconVolume] = useState(1);

  const [sttProvider, setSttProvider] = useState<"openai-whisper" | "deepgram">("openai-whisper");
  const [sttModel, setSttModel] = useState("whisper-1");
  const [sttLanguage, setSttLanguage] = useState("en");
  const [sttVocabulary, setSttVocabulary] = useState("");
  const [ttsProvider, setTtsProvider] = useState<"elevenlabs" | "openai" | "cartesia">("elevenlabs");
  const [ttsModel, setTtsModel] = useState("eleven_flash_v2_5");
  const [ttsVoice, setTtsVoice] = useState("CwhRBWXzGAHq8TQ4Fs17");
  const [turnMode, setTurnMode] = useState<"vad" | "manual" | "keyword">("vad");
  // Each kept as a single textarea string with one keyword per line.
  // We split on save and join on load so the array shape lives only at
  // the API boundary; the UI is simpler with a plain text field.
  const [keywordStart, setKeywordStart] = useState("Pi, come in");
  const [keywordEnd, setKeywordEnd] = useState("Pi, that's all");
  const [keywordScrap, setKeywordScrap] = useState("Pi, scrap that");
  const [keywordRedo, setKeywordRedo] = useState("Pi, do over");
  const [keywordReplay, setKeywordReplay] = useState("Pi, say again");
  const [keywordAbort, setKeywordAbort] = useState("Pi, abort");
  const [keywordThreshold, setKeywordThreshold] = useState(0.75);
  const [keywordMaxArmedSeconds, setKeywordMaxArmedSeconds] = useState(60);
  const [gatingEnabled, setGatingEnabled] = useState(true);
  const [gatingPrerollMs, setGatingPrerollMs] = useState(300);
  const [gatingHangoverMs, setGatingHangoverMs] = useState(600);
  const [gatingActivationThreshold, setGatingActivationThreshold] = useState(0.5);
  const [gatingMinSpeechMs, setGatingMinSpeechMs] = useState(50);
  const [gatingMinSilenceMs, setGatingMinSilenceMs] = useState(550);
  const [gatingPrefixPaddingMs, setGatingPrefixPaddingMs] = useState(500);
  const [interruptOnTurnStart, setInterruptOnTurnStart] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [androidMicDeviceId, setAndroidMicDeviceId] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [androidMicDevices, setAndroidMicDevices] = useState<AndroidMicrophone[]>([]);

  // Both dropdowns render on both platforms — the connect-time logic
  // (NativeTransport vs WebTransport) already picks whichever field
  // matches the runtime, so configuring the "other" platform's mic from
  // the current one is a no-op locally and useful for cross-device setup.
  // Note: listAndroidMicrophones() only returns entries when running
  // inside the Android wrapper; on desktop it's [].
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setMicDevices(devs.filter((d) => d.kind === "audioinput"));
      } catch (err) {
        console.warn("[settings] enumerateDevices failed:", err);
      }
    };
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // Android wrapper: enumerate hardware mics through the JS bridge.
  // No devicechange equivalent exposed — the user can hit the refresh
  // button below if they hot-plug a BT headset while the form is open.
  const [androidMicTick, setAndroidMicTick] = useState(0);
  useEffect(() => {
    setAndroidMicDevices(listAndroidMicrophones());
  }, [androidMicTick]);

  function splitKeywords(text: string): string[] {
    return text.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  function arrayFromConfig(v: unknown, fallback: string[]): string[] {
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.trim()) return [v];
    return fallback;
  }
  function androidMicLabel(d: AndroidMicrophone): string {
    // Most useful info first: typeName ("Bluetooth (SCO)") and the
    // OEM-supplied product name when present. Fall back to address /
    // id only when the rest is missing — addresses are rarely friendly
    // (BT MACs, alsa device strings).
    const parts: string[] = [d.typeName];
    if (d.productName && d.productName !== d.typeName) parts.push(d.productName);
    if (parts.length === 1 && d.address) parts.push(d.address);
    return `${parts.join(" — ")} (id ${d.id})`;
  }

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const [elVoices, setElVoices] = useState<ElevenLabsVoice[] | null>(null);
  const [elVoicesError, setElVoicesError] = useState<string | null>(null);
  const [elVoicesLoading, setElVoicesLoading] = useState(false);

  const [elRefreshTick, setElRefreshTick] = useState(0);

  // Lazy-load ElevenLabs voices when the user lands on the tab AND has
  // ElevenLabs picked. Refresh tick (incremented by refreshElVoices)
  // re-runs the effect with refresh=1 to bypass the server's 5-minute cache.
  useEffect(() => {
    if (ttsProvider !== "elevenlabs") return;
    if (elVoices !== null && elRefreshTick === 0) return;
    if (elVoicesLoading) return;
    setElVoicesLoading(true);
    setElVoicesError(null);
    const force = elRefreshTick > 0;
    api
      .elevenLabsVoices({ refresh: force })
      .then((res) => {
        if (res.ok) setElVoices(res.voices);
        else setElVoicesError(res.error ?? "fetch failed");
      })
      .catch((err) => setElVoicesError(err.message))
      .finally(() => setElVoicesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsProvider, elRefreshTick]);

  function refreshElVoices() {
    setElVoices(null);
    setElVoicesError(null);
    setElRefreshTick((n) => n + 1);
  }

  useEffect(() => {
    if (!config) return;
    setDefaultFolder(config.startup.defaultFolder ?? "");
    setTmuxSocket(config.tmux.socketName);
    setSpawnIfMissing(config.startup.spawnIfMissing);
    setSpawnTmuxSession(config.startup.spawnTmuxSession);
    setEarconsEnabled(config.voice.earcons.enabled);
    setEarconOver(config.voice.earcons.over);
    setEarconCopy(config.voice.earcons.copy);
    setEarconOut(config.voice.earcons.out);
    setEarconVolume(config.voice.earcons.volume);
    setSttProvider(config.voice.stt.provider);
    setSttModel(config.voice.stt.model);
    setSttLanguage(config.voice.stt.language);
    setSttVocabulary(arrayFromConfig(config.voice.stt.vocabulary, []).join("\n"));
    setTtsProvider(config.voice.tts.provider);
    setTtsModel(config.voice.tts.model);
    setTtsVoice(config.voice.tts.voiceId);
    setTurnMode(config.voice.turnMode);
    // Defensive: an older server may not be sending the keywords block
    // yet (config schema added it). Fall back to the same defaults the
    // server's DEFAULTS uses so the form renders rather than crashing.
    // Server may also send legacy single-string format from a pre-array
    // schema; normalize to array first then join one per line.
    const k = config.voice.keywords;
    setKeywordStart(arrayFromConfig(k?.start, ["Pi, come in"]).join("\n"));
    setKeywordEnd(arrayFromConfig(k?.end, ["Pi, that's all"]).join("\n"));
    setKeywordScrap(arrayFromConfig(k?.scrap, ["Pi, scrap that"]).join("\n"));
    setKeywordRedo(arrayFromConfig(k?.redo, ["Pi, do over"]).join("\n"));
    setKeywordReplay(arrayFromConfig(k?.replay, ["Pi, say again"]).join("\n"));
    setKeywordAbort(arrayFromConfig(k?.abort, ["Pi, abort"]).join("\n"));
    setKeywordThreshold(k?.matchThreshold ?? 0.75);
    setKeywordMaxArmedSeconds(k?.maxArmedSeconds ?? 60);
    const g = config.voice.keywordGating;
    setGatingEnabled(g?.enabled ?? true);
    setGatingPrerollMs(g?.prerollMs ?? 300);
    setGatingHangoverMs(g?.hangoverMs ?? 600);
    setGatingActivationThreshold(g?.activationThreshold ?? 0.5);
    setGatingMinSpeechMs(g?.minSpeechDurationMs ?? 50);
    setGatingMinSilenceMs(g?.minSilenceDurationMs ?? 550);
    setGatingPrefixPaddingMs(g?.prefixPaddingMs ?? 500);
    setMicEnabled(config.voice.micEnabled ?? true);
    setInterruptOnTurnStart(config.voice.interruptOnTurnStart ?? true);
    setMicDeviceId(config.voice.micDeviceId ?? null);
    setAndroidMicDeviceId(config.voice.androidMicDeviceId ?? null);
  }, [config]);

  // Did the user change any setting that only takes effect on next dispatch?
  // We compare the form state to the persisted config rather than tracking
  // a dirty flag — that way SettingsTab survives StrictMode double-render.
  const voiceSettingsDirty = useMemo(() => {
    if (!config) return false;
    return (
      sttProvider !== config.voice.stt.provider ||
      sttModel !== config.voice.stt.model ||
      sttLanguage !== config.voice.stt.language ||
      JSON.stringify(splitKeywords(sttVocabulary)) !== JSON.stringify(arrayFromConfig(config.voice.stt.vocabulary, [])) ||
      ttsProvider !== config.voice.tts.provider ||
      ttsModel !== config.voice.tts.model ||
      ttsVoice !== config.voice.tts.voiceId ||
      turnMode !== config.voice.turnMode ||
      JSON.stringify(splitKeywords(keywordStart)) !== JSON.stringify(arrayFromConfig(config.voice.keywords?.start, ["Pi, come in"])) ||
      JSON.stringify(splitKeywords(keywordEnd)) !== JSON.stringify(arrayFromConfig(config.voice.keywords?.end, ["Pi, that's all"])) ||
      JSON.stringify(splitKeywords(keywordScrap)) !== JSON.stringify(arrayFromConfig(config.voice.keywords?.scrap, ["Pi, scrap that"])) ||
      JSON.stringify(splitKeywords(keywordRedo)) !== JSON.stringify(arrayFromConfig(config.voice.keywords?.redo, ["Pi, do over"])) ||
      JSON.stringify(splitKeywords(keywordReplay)) !== JSON.stringify(arrayFromConfig(config.voice.keywords?.replay, ["Pi, say again"])) ||
      JSON.stringify(splitKeywords(keywordAbort)) !== JSON.stringify(arrayFromConfig(config.voice.keywords?.abort, ["Pi, abort"])) ||
      keywordThreshold !== (config.voice.keywords?.matchThreshold ?? 0.75) ||
      keywordMaxArmedSeconds !== (config.voice.keywords?.maxArmedSeconds ?? 60) ||
      gatingEnabled !== (config.voice.keywordGating?.enabled ?? true) ||
      gatingPrerollMs !== (config.voice.keywordGating?.prerollMs ?? 300) ||
      gatingHangoverMs !== (config.voice.keywordGating?.hangoverMs ?? 600) ||
      gatingActivationThreshold !== (config.voice.keywordGating?.activationThreshold ?? 0.5) ||
      gatingMinSpeechMs !== (config.voice.keywordGating?.minSpeechDurationMs ?? 50) ||
      gatingMinSilenceMs !== (config.voice.keywordGating?.minSilenceDurationMs ?? 550) ||
      gatingPrefixPaddingMs !== (config.voice.keywordGating?.prefixPaddingMs ?? 500) ||
      interruptOnTurnStart !== (config.voice.interruptOnTurnStart ?? true) ||
      micEnabled !== (config.voice.micEnabled ?? true) ||
      micDeviceId !== (config.voice.micDeviceId ?? null) ||
      androidMicDeviceId !== (config.voice.androidMicDeviceId ?? null)
    );
  }, [config, sttProvider, sttModel, sttLanguage, sttVocabulary, ttsProvider, ttsModel, ttsVoice, turnMode, keywordStart, keywordEnd, keywordScrap, keywordRedo, keywordReplay, keywordAbort, keywordThreshold, keywordMaxArmedSeconds, gatingEnabled, gatingPrerollMs, gatingHangoverMs, gatingActivationThreshold, gatingMinSpeechMs, gatingMinSilenceMs, gatingPrefixPaddingMs, interruptOnTurnStart, micEnabled, micDeviceId, androidMicDeviceId]);

  async function save(): Promise<boolean> {
    setError(null);
    try {
      await api.putConfig({
        tmux: { socketName: tmuxSocket || "mysystem" },
        startup: {
          defaultFolder: defaultFolder.trim() || null,
          spawnIfMissing,
          spawnTmuxSession: spawnTmuxSession || "voice-bridge-pi",
        },
        voice: {
          earcons: {
            enabled: earconsEnabled,
            over: earconOver,
            copy: earconCopy,
            out: earconOut,
            volume: earconVolume,
          },
          stt: {
            provider: sttProvider,
            model: sttModel || STT_DEFAULT_MODEL[sttProvider],
            language: sttLanguage || "en",
            vocabulary: splitKeywords(sttVocabulary),
          },
          tts: {
            provider: ttsProvider,
            model: ttsModel || TTS_DEFAULT_MODEL[ttsProvider],
            voiceId: ttsVoice || TTS_DEFAULT_VOICE[ttsProvider],
          },
          turnMode,
          keywords: {
            start: splitKeywords(keywordStart).length > 0 ? splitKeywords(keywordStart) : ["Pi, come in"],
            end: splitKeywords(keywordEnd).length > 0 ? splitKeywords(keywordEnd) : ["Pi, that's all"],
            scrap: splitKeywords(keywordScrap).length > 0 ? splitKeywords(keywordScrap) : ["Pi, scrap that"],
            redo: splitKeywords(keywordRedo).length > 0 ? splitKeywords(keywordRedo) : ["Pi, do over"],
            replay: splitKeywords(keywordReplay).length > 0 ? splitKeywords(keywordReplay) : ["Pi, say again"],
            abort: splitKeywords(keywordAbort).length > 0 ? splitKeywords(keywordAbort) : ["Pi, abort"],
            matchThreshold: keywordThreshold,
            maxArmedSeconds: keywordMaxArmedSeconds,
          },
          keywordGating: {
            enabled: gatingEnabled,
            prerollMs: gatingPrerollMs,
            hangoverMs: gatingHangoverMs,
            activationThreshold: gatingActivationThreshold,
            minSpeechDurationMs: gatingMinSpeechMs,
            minSilenceDurationMs: gatingMinSilenceMs,
            prefixPaddingMs: gatingPrefixPaddingMs,
          },
          interruptOnTurnStart,
          micEnabled,
          micDeviceId,
          androidMicDeviceId,
        },
      });
      setSavedAt(Date.now());
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }

  async function saveAndReconnect() {
    const ok = await save();
    if (!ok) return;
    setReconnecting(true);
    try {
      await onReconnect();
    } finally {
      setReconnecting(false);
    }
  }

  function onSttProviderChange(p: "openai-whisper" | "deepgram") {
    setSttProvider(p);
    const models = STT_MODELS[p] as readonly string[];
    if (!models.includes(sttModel)) {
      setSttModel(STT_DEFAULT_MODEL[p]);
    }
  }

  function onTtsProviderChange(p: "elevenlabs" | "openai" | "cartesia") {
    setTtsProvider(p);
    const models = TTS_MODELS[p] as readonly string[];
    if (!models.includes(ttsModel)) {
      setTtsModel(TTS_DEFAULT_MODEL[p]);
    }
    // Voice resets only if it's a known catalogue voice from another
    // provider; user-typed ElevenLabs/Cartesia IDs are preserved otherwise.
    const knownVoiceFromAny = (OPENAI_VOICES as readonly string[]).includes(ttsVoice);
    const isCurrentProviderDefault = ttsVoice === TTS_DEFAULT_VOICE.elevenlabs ||
                                     ttsVoice === TTS_DEFAULT_VOICE.cartesia;
    if (knownVoiceFromAny || isCurrentProviderDefault || ttsVoice === "") {
      setTtsVoice(TTS_DEFAULT_VOICE[p]);
    }
  }

  if (!config) return <div style={{ padding: 16, color: "#888" }}>Loading config…</div>;

  return (
    <div style={{ padding: 16, maxWidth: 760, height: "100%", overflowY: "auto" }}>
      <h2 style={{ fontSize: 14, color: "#c0c0d0", marginBottom: 12 }}>Settings</h2>

      <Section title="Pi sessions">
        <Field label="Default folder">
          <input
            type="text"
            value={defaultFolder}
            placeholder="~/dev/myproject (leave empty for explicit pick)"
            onChange={(e) => setDefaultFolder(e.target.value)}
            style={inputStyle}
          />
          <p style={hintStyle}>
            Server checks for a Pi running in this folder on UI start.
            If missing and Spawn-if-missing is on, it spawns one in tmux.
            Tildes are expanded.
          </p>
        </Field>

        <Field label="Spawn if missing">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={spawnIfMissing}
              onChange={(e) => setSpawnIfMissing(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>
              Start <code>pi</code> in default folder when no live session matches
            </span>
          </label>
        </Field>

        <Field label="tmux socket">
          <input
            type="text"
            value={tmuxSocket}
            onChange={(e) => setTmuxSocket(e.target.value)}
            style={inputStyle}
          />
          <p style={hintStyle}>
            Passed as <code>tmux -L &lt;name&gt;</code>. Changing this requires a server restart for wterm to follow.
          </p>
        </Field>

        <Field label="Spawn tmux session">
          <input
            type="text"
            value={spawnTmuxSession}
            onChange={(e) => setSpawnTmuxSession(e.target.value)}
            style={inputStyle}
          />
          <p style={hintStyle}>
            When spawning a Pi, a window is created inside this tmux session.
          </p>
        </Field>
      </Section>

      <Section title="Speech recognition (STT)">
        <Field label="Provider">
          <select
            value={sttProvider}
            onChange={(e) => onSttProviderChange(e.target.value as "openai-whisper" | "deepgram")}
            style={inputStyle}
          >
            <option value="openai-whisper">OpenAI Whisper (uses OPENAI_API_KEY)</option>
            <option value="deepgram">Deepgram (uses DEEPGRAM_API_KEY)</option>
          </select>
        </Field>
        <Field label="Model">
          <select
            value={sttModel}
            onChange={(e) => setSttModel(e.target.value)}
            style={inputStyle}
          >
            {STT_MODELS[sttProvider].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language">
          <select
            value={sttLanguage}
            onChange={(e) => setSttLanguage(e.target.value)}
            style={inputStyle}
          >
            {STT_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <p style={hintStyle}>ISO 639-1 code, or "multi" for auto-detect on Deepgram.</p>
        </Field>
        <Field label="Custom vocabulary">
          <textarea
            value={sttVocabulary}
            onChange={(e) => setSttVocabulary(e.target.value)}
            placeholder="boxyard&#10;livekit&#10;sherpa-onnx"
            rows={4}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Proper nouns, project names, jargon — one per line. Helps STT render uncommon terms
            correctly (e.g. "boxyard" not "box yard"). On Deepgram Nova-3 this is sent as
            <code> keyterm </code>(English only); on older Deepgram models as
            <code> keywords </code>(any language). On Whisper it's joined into the
            <code> prompt </code>parameter as a soft bias. Up to 100 terms.
          </p>
        </Field>
      </Section>

      <Section title="Speech synthesis (TTS)">
        <Field label="Provider">
          <select
            value={ttsProvider}
            onChange={(e) => onTtsProviderChange(e.target.value as "elevenlabs" | "openai" | "cartesia")}
            style={inputStyle}
          >
            <option value="elevenlabs">ElevenLabs (uses ELEVENLABS_API_KEY / ELEVEN_API_KEY)</option>
            <option value="openai">OpenAI TTS (uses OPENAI_API_KEY)</option>
            <option value="cartesia">Cartesia (uses CARTESIA_API_KEY)</option>
          </select>
          <p style={hintStyle}>
            Note: Deepgram is not a TTS provider — it only does STT.
          </p>
        </Field>
        <Field label="Model">
          <select
            value={ttsModel}
            onChange={(e) => setTtsModel(e.target.value)}
            style={inputStyle}
          >
            {TTS_MODELS[ttsProvider].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Voice">
          {ttsProvider === "openai" ? (
            <select
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              style={inputStyle}
            >
              {OPENAI_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : ttsProvider === "elevenlabs" ? (
            <ElevenLabsVoicePicker
              value={ttsVoice}
              onChange={setTtsVoice}
              voices={elVoices}
              loading={elVoicesLoading}
              error={elVoicesError}
              onRefresh={refreshElVoices}
            />
          ) : (
            <input
              type="text"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
              placeholder={TTS_DEFAULT_VOICE[ttsProvider]}
              style={inputStyle}
            />
          )}
          <p style={hintStyle}>
            {ttsProvider === "elevenlabs"
              ? 'Voices in your ElevenLabs account (My Voices). Public Library voices must be "Added to my voices" on elevenlabs.io before they\'ll work.'
              : ttsProvider === "openai"
              ? "OpenAI voice — picked from a fixed catalogue."
              : "Cartesia voice ID (UUID). Browse at play.cartesia.ai/voices."}
          </p>
        </Field>
      </Section>

      <Section title="Microphone">
        <Field label="Enabled">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={micEnabled}
              onChange={(e) => setMicEnabled(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>
              When off, the microphone stays muted in every mode (privacy override).
              Also toggleable from the 🎙 / 🚫 button in the top bar.
            </span>
          </label>
        </Field>
        <Field label="Input device (web)">
          <select
            value={micDeviceId ?? ""}
            onChange={(e) => setMicDeviceId(e.target.value === "" ? null : e.target.value)}
            style={inputStyle}
          >
            <option value="">Default (let the browser choose)</option>
            {micDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${d.deviceId.slice(0, 8)}…`}
              </option>
            ))}
          </select>
          <p style={hintStyle}>
            Used when this page is loaded in a browser (desktop or mobile web).
            Device labels stay hidden until the page has been granted
            microphone permission, so on first load you may see generic IDs;
            after a successful Connect voice they populate with real names.
            Changing the device requires a reconnect.
          </p>
        </Field>
        <Field label="Input device (Android wrapper)">
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={androidMicDeviceId ?? ""}
              onChange={(e) =>
                setAndroidMicDeviceId(e.target.value === "" ? null : e.target.value)
              }
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="">Default (let Android pick)</option>
              {androidMicDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {androidMicLabel(d)}
                </option>
              ))}
              {androidMicDeviceId &&
                !androidMicDevices.some((d) => d.id === androidMicDeviceId) && (
                  <option value={androidMicDeviceId}>
                    Saved id {androidMicDeviceId} (not currently visible)
                  </option>
                )}
            </select>
            <button
              type="button"
              onClick={() => setAndroidMicTick((n) => n + 1)}
              style={{
                padding: "6px 12px",
                background: "#2a2a3a",
                color: "#c8c8d4",
                border: "1px solid #3a3a4a",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Refresh
            </button>
          </div>
          <p style={hintStyle}>
            Used when this page is loaded inside the sideloaded Android app —
            kept separate from the web setting so one config can drive both
            clients. The list only populates when viewed from inside the
            wrapper itself; from a desktop browser the dropdown is empty, but
            you can still clear or keep an existing selection. Hot-pluggable
            mics (Bluetooth, USB, wired) get fresh IDs each time they
            reconnect, so a saved entry that's no longer present silently
            falls back to the OS default. Changing the device requires a
            reconnect.
          </p>
        </Field>
      </Section>

      <Section title="Turn detection — mode">
        <Field label="Mode">
          <select
            value={turnMode}
            onChange={(e) => setTurnMode(e.target.value as "vad" | "manual" | "keyword")}
            style={inputStyle}
          >
            <option value="vad">Automatic (VAD detects when you stop speaking)</option>
            <option value="manual">Manual (push-to-talk: tap a button to start/stop)</option>
            <option value="keyword">Keyword (speak a phrase to start and end each turn)</option>
          </select>
          <p style={hintStyle}>
            You can also cycle through modes on the fly via the <code>VAD</code>/<code>PTT</code>/<code>KW</code> badge in the top bar.
            Switching to or from keyword mode requires a reconnect, since it changes how the agent listens.
          </p>
        </Field>
        <Field label="Interrupt on new turn">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={interruptOnTurnStart}
              onChange={(e) => setInterruptOnTurnStart(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>
              When you start a new turn (keyword arm / push-to-talk), immediately
              stop the agent's reply so it doesn't talk over you. (Automatic/VAD
              mode already interrupts when you start speaking.)
            </span>
          </label>
        </Field>
      </Section>

      <Section title="Keyword mode — phrases">
        <p style={{ ...hintStyle, marginTop: 0 }}>
          Configure these any time; they only apply while the mode above is set to <em>Keyword</em>.
          One phrase per line — any of them can match. Useful for catching common STT mishearings
          (e.g. add "Pie, come in" or "High, come in" alongside "Pi, come in").
        </p>
        <Field label="Start phrases">
          <textarea
            value={keywordStart}
            onChange={(e) => setKeywordStart(e.target.value)}
            placeholder="Pi, come in&#10;Pie, come in"
            rows={3}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Spoken before each message to begin recording. Match is case-insensitive,
            tolerant of punctuation, and uses fuzzy similarity (see threshold below).
          </p>
        </Field>
        <Field label="End phrases">
          <textarea
            value={keywordEnd}
            onChange={(e) => setKeywordEnd(e.target.value)}
            placeholder="Pi, that's all&#10;Pie, that's all"
            rows={3}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Spoken after the message to send it. Whichever phrase matched is stripped from the
            transcript before reaching Pi.
          </p>
        </Field>
        <Field label="Scrap phrases">
          <textarea
            value={keywordScrap}
            onChange={(e) => setKeywordScrap(e.target.value)}
            placeholder="Pi, scrap that"
            rows={2}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Spoken mid-message to discard it and stop listening. Equivalent to closing
            the mic without sending.
          </p>
        </Field>
        <Field label="Redo phrases">
          <textarea
            value={keywordRedo}
            onChange={(e) => setKeywordRedo(e.target.value)}
            placeholder="Pi, do over"
            rows={2}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Spoken mid-message to discard it and start over from the beginning, as if
            you'd just said the start phrase again.
          </p>
        </Field>
        <Field label="Replay phrases">
          <textarea
            value={keywordReplay}
            onChange={(e) => setKeywordReplay(e.target.value)}
            placeholder="Pi, say again"
            rows={2}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Spoken between turns (when not currently composing a message) to re-speak
            the agent's last response.
          </p>
        </Field>
        <Field label="Abort phrases">
          <textarea
            value={keywordAbort}
            onChange={(e) => setKeywordAbort(e.target.value)}
            placeholder="Pi, abort"
            rows={2}
            style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
          />
          <p style={hintStyle}>
            Spoken at any time to tell Pi to stop whatever it's currently doing —
            equivalent to pressing escape in the TUI. Also interrupts the agent if
            it's mid-response. Recognized whether or not you're currently composing
            a message.
          </p>
        </Field>
        <Field label={`Match threshold: ${keywordThreshold.toFixed(2)}`}>
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.05}
            value={keywordThreshold}
            onChange={(e) => setKeywordThreshold(parseFloat(e.target.value))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            How close the spoken transcript has to be to any of the phrases, on a scale of
            0.5 (very loose) to 1.0 (exact). Token-level similarity using Levenshtein
            distance — at 0.75, "high come in" still matches "Pi come in"; at 0.9 it
            doesn't. Lower the threshold if your STT keeps mishearing the wake phrase;
            raise it if random speech triggers it.
          </p>
        </Field>
        <Field
          label={
            keywordMaxArmedSeconds === 0
              ? "Auto-scrap armed turns: disabled"
              : `Auto-scrap armed turns after: ${keywordMaxArmedSeconds}s`
          }
        >
          <input
            type="range"
            min={0}
            max={600}
            step={10}
            value={keywordMaxArmedSeconds}
            onChange={(e) => setKeywordMaxArmedSeconds(parseInt(e.target.value, 10))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            Safety net for accidentally armed sessions. If a keyword turn stays armed
            (between the start phrase and end / scrap / redo / abort) for this long, the
            worker auto-scraps it — drops any in-flight transcript, plays the scrap
            earcon, and returns to idle. Critical because armed mode bypasses the VAD
            gate and streams every audio frame to Deepgram. Drag to <code>0</code> to
            disable. 60s suits typical commands; raise if you regularly compose long
            messages.
          </p>
        </Field>
      </Section>

      <Section title="Keyword mode — VAD gating (cost control)">
        <p style={{ ...hintStyle, marginTop: 0 }}>
          Only forward audio to Deepgram when on-device VAD detects speech.
          Without this, keyword mode streams continuously and bills for silence
          (~$11/day at Deepgram Nova-3 PAYG). With it, billed seconds drop to
          roughly the time someone is talking nearby. Only applies in
          <em> Keyword</em> mode with the <em>Deepgram</em> STT provider.
        </p>
        <Field label="Enabled">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={gatingEnabled}
              onChange={(e) => setGatingEnabled(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Gate Deepgram on Silero VAD</span>
          </label>
        </Field>
        <Field label={`Preroll: ${gatingPrerollMs} ms`}>
          <input
            type="range"
            min={0}
            max={1000}
            step={50}
            value={gatingPrerollMs}
            disabled={!gatingEnabled}
            onChange={(e) => setGatingPrerollMs(parseInt(e.target.value, 10))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            How much audio leading up to the gate-open trigger gets flushed to
            Deepgram. Recovers the leading phoneme of "Pi" that VAD inference
            latency would otherwise clip. Bump if "Pi" gets mis-transcribed as
            "eye" or dropped; lower if you don't care.
          </p>
        </Field>
        <Field label={`Hangover: ${gatingHangoverMs} ms`}>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={gatingHangoverMs}
            disabled={!gatingEnabled}
            onChange={(e) => setGatingHangoverMs(parseInt(e.target.value, 10))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            After VAD reports end-of-speech, keep streaming this long before
            closing the gate. Bridges short pauses inside an utterance ("Pi…
            come in") so a single phrase isn't cut into two.
          </p>
        </Field>
        <Field label={`VAD activation threshold: ${gatingActivationThreshold.toFixed(2)}`}>
          <input
            type="range"
            min={0.1}
            max={0.9}
            step={0.05}
            value={gatingActivationThreshold}
            disabled={!gatingEnabled}
            onChange={(e) => setGatingActivationThreshold(parseFloat(e.target.value))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            Silero speech-probability threshold above which a frame is
            considered speech. Lower = more sensitive (catches quiet speech but
            triggers on background noise); higher = stricter (saves more cost
            but may drop quiet wake-words). 0.5 is Silero's default.
          </p>
        </Field>
        <Field label={`Min speech duration: ${gatingMinSpeechMs} ms`}>
          <input
            type="range"
            min={20}
            max={500}
            step={10}
            value={gatingMinSpeechMs}
            disabled={!gatingEnabled}
            onChange={(e) => setGatingMinSpeechMs(parseInt(e.target.value, 10))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            How long sustained high-probability frames must persist before
            Silero declares speech. Lower = faster gate-open but more false
            positives from clicks/coughs. The preroll above is what actually
            recovers the audio leading up to this trigger.
          </p>
        </Field>
        <Field label={`Min silence duration: ${gatingMinSilenceMs} ms`}>
          <input
            type="range"
            min={100}
            max={2000}
            step={50}
            value={gatingMinSilenceMs}
            disabled={!gatingEnabled}
            onChange={(e) => setGatingMinSilenceMs(parseInt(e.target.value, 10))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            How long Silero waits in silence before declaring end-of-speech.
            This is separate from <em>hangover</em>: silence-duration is the
            VAD's own end-of-speech debounce, hangover is how much longer the
            gate stays open after that.
          </p>
        </Field>
        <Field label={`Silero prefix padding: ${gatingPrefixPaddingMs} ms`}>
          <input
            type="range"
            min={0}
            max={1000}
            step={50}
            value={gatingPrefixPaddingMs}
            disabled={!gatingEnabled}
            onChange={(e) => setGatingPrefixPaddingMs(parseInt(e.target.value, 10))}
            style={{ width: "100%" }}
          />
          <p style={hintStyle}>
            Silero's own internal pre-trigger buffer. Distinct from the
            wrapper's preroll above — this only affects what frames Silero
            attaches to its own START_OF_SPEECH event (which the gate doesn't
            consume directly). Usually leave at the default unless tuning
            advanced behavior.
          </p>
        </Field>
      </Section>

      <Section title="Earcons (radio etiquette tones)">
        <Field label="Enabled">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={earconsEnabled}
              onChange={(e) => setEarconsEnabled(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Master toggle</span>
          </label>
        </Field>
        <Field label="Per-event">
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={earconOver}
                disabled={!earconsEnabled}
                onChange={(e) => setEarconOver(e.target.checked)}
              />
              over <span style={{ color: "#666" }}>(user-stop)</span>
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              title="Off by default: 'copy' uses session.say() during the LLM stream, which blocks pipelineReply's progressive TTS playback."
            >
              <input
                type="checkbox"
                checked={earconCopy}
                disabled={!earconsEnabled}
                onChange={(e) => setEarconCopy(e.target.checked)}
              />
              copy <span style={{ color: "#666" }}>(agent-start, blocks streaming)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={earconOut}
                disabled={!earconsEnabled}
                onChange={(e) => setEarconOut(e.target.checked)}
              />
              out <span style={{ color: "#666" }}>(agent-end)</span>
            </label>
          </div>
        </Field>
        <Field label={`Volume — ${Math.round(earconVolume * 100)}%`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={earconVolume}
            disabled={!earconsEnabled}
            onChange={(e) => setEarconVolume(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </Field>
      </Section>

      {voiceConnected && voiceSettingsDirty && (
        <div
          style={{
            padding: "8px 12px",
            background: "#332a18",
            border: "1px solid #8a6a18",
            borderRadius: 4,
            fontSize: 12,
            color: "#fa5",
            marginBottom: 12,
          }}
        >
          You're connected to a voice session. STT/TTS/turn-mode changes only take effect on the
          next dispatch — click <strong>Save &amp; reconnect</strong> to apply now.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={save} style={btnPrimary}>
          Save
        </button>
        {voiceConnected && voiceSettingsDirty && (
          <button onClick={saveAndReconnect} disabled={reconnecting} style={btnAccent}>
            {reconnecting ? "Reconnecting…" : "Save & reconnect"}
          </button>
        )}
        {savedAt && (
          <span style={{ fontSize: 11, color: "#7a7" }}>
            saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        {error && <span style={{ fontSize: 11, color: "#f66" }}>{error}</span>}
      </div>

      <details style={{ marginTop: 24 }}>
        <summary style={{ fontSize: 11, color: "#666", cursor: "pointer" }}>raw config</summary>
        <pre
          style={{
            background: "#0d0d1a",
            padding: 10,
            borderRadius: 4,
            fontFamily: "'SF Mono', monospace",
            fontSize: 10,
            color: "#888",
            marginTop: 6,
            overflowX: "auto",
          }}
        >
          {JSON.stringify(config, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ElevenLabsVoicePicker({
  value,
  onChange,
  voices,
  loading,
  error,
  onRefresh,
}: {
  value: string;
  onChange: (v: string) => void;
  voices: ElevenLabsVoice[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <div style={{ ...inputStyle, color: "#888", display: "flex", alignItems: "center" }}>
        Loading your voices…
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
        <div style={{ fontSize: 11, color: "#fa5", marginTop: 4 }}>
          Couldn't fetch your ElevenLabs voices: {error}. Falling back to manual entry.{" "}
          <button onClick={onRefresh} style={linkBtn}>retry</button>
        </div>
      </div>
    );
  }
  if (!voices || voices.length === 0) {
    return (
      <div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
        <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
          No voices found in your ElevenLabs account. Add some at{" "}
          <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noreferrer">
            voice library
          </a>
          .
        </div>
      </div>
    );
  }
  // Group: cloned/professional first, then library/premade. Within each
  // group, alphabetical.
  const sorted = [...voices].sort((a, b) => {
    const aw = priority(a.category);
    const bw = priority(b.category);
    if (aw !== bw) return aw - bw;
    return a.name.localeCompare(b.name);
  });
  const valueIsKnown = sorted.some((v) => v.voice_id === value);
  return (
    <div>
      <select
        value={valueIsKnown ? value : "__custom__"}
        onChange={(e) => {
          if (e.target.value !== "__custom__") onChange(e.target.value);
        }}
        style={inputStyle}
      >
        {!valueIsKnown && (
          <option value="__custom__">{value || "(custom — type below)"}</option>
        )}
        {sorted.map((v) => (
          <option key={v.voice_id} value={v.voice_id}>
            {v.name}
            {v.category ? ` · ${v.category}` : ""}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="or paste a voice ID"
          style={{ ...inputStyle, fontSize: 11, padding: "4px 8px", width: "auto", flex: 1 }}
        />
        <button onClick={onRefresh} style={linkBtn} title="Refetch from ElevenLabs">
          refresh
        </button>
      </div>
    </div>
  );
}

function priority(category?: string): number {
  if (category === "cloned") return 0;
  if (category === "professional") return 1;
  if (category === "generated") return 2;
  if (category === "premade") return 3;
  return 4;
}

const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: "#5a8af0",
  border: "none",
  cursor: "pointer",
  fontSize: 11,
  textDecoration: "underline",
  padding: 0,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 12, color: "#9090a8", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {title}
      </h3>
      <div style={{ paddingLeft: 4 }}>{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11, color: "#9090a8", marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "#0d0d1a",
  color: "#e6e6f0",
  border: "1px solid #2a2a40",
  borderRadius: 4,
  fontFamily: "'SF Mono', monospace",
  fontSize: 12,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  lineHeight: 1.5,
  marginTop: 4,
};

const btnPrimary: React.CSSProperties = {
  padding: "6px 16px",
  background: "#5a57b3",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
};

const btnAccent: React.CSSProperties = {
  ...btnPrimary,
  background: "#a36",
};
