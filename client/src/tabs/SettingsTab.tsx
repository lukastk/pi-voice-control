import { useEffect, useMemo, useState } from "react";
import { api, type Config, type ElevenLabsVoice } from "../api.ts";
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
  const [ttsProvider, setTtsProvider] = useState<"elevenlabs" | "openai" | "cartesia">("elevenlabs");
  const [ttsModel, setTtsModel] = useState("eleven_flash_v2_5");
  const [ttsVoice, setTtsVoice] = useState("CwhRBWXzGAHq8TQ4Fs17");
  const [turnMode, setTurnMode] = useState<"vad" | "manual" | "keyword">("vad");
  const [keywordStart, setKeywordStart] = useState("Pi, come in");
  const [keywordEnd, setKeywordEnd] = useState("Pi, that's all");
  const [keywordThreshold, setKeywordThreshold] = useState(0.75);

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
    setTtsProvider(config.voice.tts.provider);
    setTtsModel(config.voice.tts.model);
    setTtsVoice(config.voice.tts.voiceId);
    setTurnMode(config.voice.turnMode);
    // Defensive: an older server may not be sending the keywords block
    // yet (config schema added it). Fall back to the same defaults the
    // server's DEFAULTS uses so the form renders rather than crashing.
    setKeywordStart(config.voice.keywords?.start ?? "Pi, come in");
    setKeywordEnd(config.voice.keywords?.end ?? "Pi, that's all");
    setKeywordThreshold(config.voice.keywords?.matchThreshold ?? 0.75);
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
      ttsProvider !== config.voice.tts.provider ||
      ttsModel !== config.voice.tts.model ||
      ttsVoice !== config.voice.tts.voiceId ||
      turnMode !== config.voice.turnMode ||
      keywordStart !== (config.voice.keywords?.start ?? "Pi, come in") ||
      keywordEnd !== (config.voice.keywords?.end ?? "Pi, that's all") ||
      keywordThreshold !== (config.voice.keywords?.matchThreshold ?? 0.75)
    );
  }, [config, sttProvider, sttModel, sttLanguage, ttsProvider, ttsModel, ttsVoice, turnMode, keywordStart, keywordEnd, keywordThreshold]);

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
          },
          tts: {
            provider: ttsProvider,
            model: ttsModel || TTS_DEFAULT_MODEL[ttsProvider],
            voiceId: ttsVoice || TTS_DEFAULT_VOICE[ttsProvider],
          },
          turnMode,
          keywords: {
            start: keywordStart.trim() || "Pi, come in",
            end: keywordEnd.trim() || "Pi, that's all",
            matchThreshold: keywordThreshold,
          },
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

      <Section title="Turn detection">
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
            You can also flip between VAD and PTT on the fly via the <code>VAD</code>/<code>PTT</code> badge in the top bar.
            Switching to or from keyword mode requires a reconnect, since it changes how the agent listens.
          </p>
        </Field>
        {turnMode === "keyword" && (
          <>
            <Field label="Start phrase">
              <input
                type="text"
                value={keywordStart}
                onChange={(e) => setKeywordStart(e.target.value)}
                placeholder="Pi, come in"
                style={inputStyle}
              />
              <p style={hintStyle}>
                Spoken before each message to begin recording. Match is case-insensitive
                and tolerant of punctuation.
              </p>
            </Field>
            <Field label="End phrase">
              <input
                type="text"
                value={keywordEnd}
                onChange={(e) => setKeywordEnd(e.target.value)}
                placeholder="Pi, that's all"
                style={inputStyle}
              />
              <p style={hintStyle}>
                Spoken after the message to send it. Both phrases are stripped from the
                transcript before reaching Pi.
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
                How close the spoken transcript has to be to the phrase, on a scale of
                0.5 (very loose) to 1.0 (exact). Token-level similarity using
                Levenshtein distance — at 0.75, "high come in" still matches "Pi come
                in"; at 0.9 it doesn't. Lower the threshold if your STT keeps
                mishearing the wake phrase; raise it if random speech triggers it.
              </p>
            </Field>
          </>
        )}
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
