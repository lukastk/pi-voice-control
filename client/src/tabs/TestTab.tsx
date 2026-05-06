/**
 * Test tab: try the configured STT and TTS providers without going
 * through a Pi session or LiveKit room.
 *
 *   - STT: click Record, speak, click Stop. The audio is uploaded to
 *     /api/test/stt which proxies to the configured STT provider
 *     (Whisper or Deepgram per Settings) and returns a transcript.
 *   - TTS: type into the textarea, click Speak. /api/test/tts proxies
 *     to the configured TTS provider and returns audio bytes that we
 *     play in an HTMLAudioElement.
 *
 * Useful for verifying API keys, picking a voice, or just hearing
 * what each provider sounds like before wiring it into a real
 * session.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

type Props = {
  sttSummary: string;
  ttsSummary: string;
};

export function TestTab({ sttSummary, ttsSummary }: Props) {
  // STT
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [sttElapsedMs, setSttElapsedMs] = useState<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // TTS
  const [ttsText, setTtsText] = useState(
    "Testing the text to speech. The quick brown fox jumps over the lazy dog.",
  );
  const [synthesizing, setSynthesizing] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string | null>(null);
  const [ttsElapsedMs, setTtsElapsedMs] = useState<number | null>(null);

  // Clean up the blob URL when it changes / on unmount.
  useEffect(() => {
    return () => {
      if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
    };
  }, [ttsAudioUrl]);

  // Best-supported recording mime type for this browser.
  function pickMimeType(): string {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  async function startRecording() {
    setRecError(null);
    setTranscript("");
    setSttElapsedMs(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = handleStopped;
      mr.start();
      setRecording(true);
    } catch (err: any) {
      setRecError(err?.message ?? String(err));
      cleanupStream();
    }
  }

  function stopRecording() {
    const mr = recorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    } else {
      cleanupStream();
      setRecording(false);
    }
  }

  function cleanupStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
  }

  async function handleStopped() {
    setRecording(false);
    const mr = recorderRef.current;
    cleanupStream();
    if (chunksRef.current.length === 0) {
      setRecError("No audio captured.");
      return;
    }
    const blob = new Blob(chunksRef.current, {
      type: mr?.mimeType || "audio/webm",
    });
    chunksRef.current = [];
    setTranscribing(true);
    const startedAt = Date.now();
    try {
      const res = await api.testStt(blob);
      setSttElapsedMs(Date.now() - startedAt);
      if (res.ok) {
        setTranscript(res.transcript ?? "");
      } else {
        setRecError(res.error ?? "transcription failed");
      }
    } catch (err: any) {
      setRecError(err?.message ?? String(err));
    } finally {
      setTranscribing(false);
    }
  }

  async function handleSpeak() {
    setTtsError(null);
    setTtsElapsedMs(null);
    if (ttsAudioUrl) {
      URL.revokeObjectURL(ttsAudioUrl);
      setTtsAudioUrl(null);
    }
    if (!ttsText.trim()) {
      setTtsError("Type something to speak first.");
      return;
    }
    setSynthesizing(true);
    const startedAt = Date.now();
    try {
      const res = await api.testTts(ttsText);
      setTtsElapsedMs(Date.now() - startedAt);
      if (res.ok) {
        const url = URL.createObjectURL(res.audio);
        setTtsAudioUrl(url);
      } else {
        setTtsError(res.error);
      }
    } catch (err: any) {
      setTtsError(err?.message ?? String(err));
    } finally {
      setSynthesizing(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <p style={{ fontSize: 12, color: "#8888a0", marginBottom: 18 }}>
        Try out the configured pipeline without a Pi session. Uses whatever
        provider/model/voice is set in Settings.
      </p>

      <Section title={`Speech to text (${sttSummary})`}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          {!recording ? (
            <button onClick={startRecording} style={btnPrimary} disabled={transcribing}>
              ● Record
            </button>
          ) : (
            <button onClick={stopRecording} style={btnRecording}>
              ■ Stop ({transcribing ? "…" : "recording"})
            </button>
          )}
          {transcribing && (
            <span style={hintStyle}>transcribing…</span>
          )}
          {sttElapsedMs !== null && !transcribing && (
            <span style={hintStyle}>round-trip {sttElapsedMs} ms</span>
          )}
        </div>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Click Record, speak, then click Stop. The transcript will appear here."
          rows={5}
          style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
        />
        {recError && (
          <p style={{ ...hintStyle, color: "#ff8080", marginTop: 6 }}>{recError}</p>
        )}
      </Section>

      <Section title={`Text to speech (${ttsSummary})`}>
        <textarea
          value={ttsText}
          onChange={(e) => setTtsText(e.target.value)}
          rows={4}
          style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button onClick={handleSpeak} style={btnPrimary} disabled={synthesizing}>
            {synthesizing ? "Synthesizing…" : "▶ Speak"}
          </button>
          {ttsElapsedMs !== null && !synthesizing && (
            <span style={hintStyle}>round-trip {ttsElapsedMs} ms</span>
          )}
        </div>
        {ttsAudioUrl && (
          <audio
            src={ttsAudioUrl}
            controls
            autoPlay
            style={{ display: "block", width: "100%", marginTop: 10 }}
          />
        )}
        {ttsError && (
          <p style={{ ...hintStyle, color: "#ff8080", marginTop: 6 }}>{ttsError}</p>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h3
        style={{
          fontSize: 12,
          color: "#9090a8",
          marginBottom: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {title}
      </h3>
      <div>{children}</div>
    </section>
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
  color: "#7878a0",
  margin: 0,
};

const btnBase: React.CSSProperties = {
  fontSize: 12,
  padding: "6px 14px",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
  border: "1px solid #3a3a55",
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: "#2a3a55",
  color: "#d0d8f0",
};

const btnRecording: React.CSSProperties = {
  ...btnBase,
  background: "#5a3a3a",
  color: "#ffd0d0",
  borderColor: "#a33",
};
