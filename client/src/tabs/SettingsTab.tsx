import { useEffect, useMemo, useState } from "react";
import { api, type Config } from "../api.ts";
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
  const [turnMode, setTurnMode] = useState<"vad" | "manual">("vad");

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

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
      turnMode !== config.voice.turnMode
    );
  }, [config, sttProvider, sttModel, sttLanguage, ttsProvider, ttsModel, ttsVoice, turnMode]);

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
              ? "ElevenLabs voice ID (20-char alphanumeric). Browse voices at elevenlabs.io/app/voice-library."
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
            onChange={(e) => setTurnMode(e.target.value as "vad" | "manual")}
            style={inputStyle}
          >
            <option value="vad">Automatic (VAD detects when you stop speaking)</option>
            <option value="manual">Manual (push-to-talk: tap a button to start/stop)</option>
          </select>
          <p style={hintStyle}>
            You can also flip this on the fly via the <code>VAD</code>/<code>PTT</code> badge in the top bar.
            Switching mid-session adjusts your mic immediately; STT/TTS provider changes need a reconnect.
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
