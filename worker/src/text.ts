/**
 * Text utilities for voice output:
 *   - SpokenTagParser:  extract <spoken>...</spoken> contents from a streaming text feed.
 *   - SpeechChunker:    fallback chunker for raw text when no <spoken> tags appear.
 *   - cleanForSpeech:   strip markdown / code / URLs to make text speakable.
 *   - toolStatusMessage: short spoken status per tool name.
 */

export class SpokenTagParser {
  private buffer = "";

  feed(text: string): string[] {
    this.buffer += text;
    const results: string[] = [];
    const regex = /<spoken>([\s\S]*?)<\/spoken>/g;
    let match: RegExpExecArray | null;
    let lastEnd = 0;

    while ((match = regex.exec(this.buffer)) !== null) {
      const content = match[1]?.trim() ?? "";
      if (content) results.push(content);
      lastEnd = match.index + match[0].length;
    }
    if (lastEnd > 0) this.buffer = this.buffer.slice(lastEnd);

    // Keep a tail that *might* be the start of a new <spoken> tag so a tag
    // split across deltas still parses next time.
    const lastOpen = this.buffer.lastIndexOf("<spoken>");
    if (lastOpen === -1) {
      const lastAngle = this.buffer.lastIndexOf("<");
      if (lastAngle !== -1 && this.buffer.length - lastAngle < "<spoken>".length) {
        this.buffer = this.buffer.slice(lastAngle);
      } else {
        this.buffer = "";
      }
    }

    return results;
  }
}

export class SpeechChunker {
  private buffer = "";

  feed(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): string[] {
    return this.drain(true);
  }

  private drain(force: boolean): string[] {
    const chunks: string[] = [];
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    while (true) {
      const boundary = this.findBoundary(force);
      if (boundary === -1) break;
      const raw = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary).trimStart();
      const cleaned = cleanForSpeech(raw);
      if (cleaned) chunks.push(cleaned + " ");
    }
    return chunks;
  }

  private findBoundary(force: boolean): number {
    if (force) return this.buffer.length;
    if (this.buffer.length < 80) return -1;

    const sentenceMatch = /[.!?](?:\s+|$)/g;
    let match: RegExpExecArray | null;
    let lastGood = -1;
    while ((match = sentenceMatch.exec(this.buffer)) !== null) {
      if (match.index + match[0].length >= 60) {
        lastGood = match.index + match[0].length;
        break;
      }
    }
    if (lastGood !== -1) return lastGood;

    const paragraph = this.buffer.indexOf("\n\n");
    if (paragraph >= 60) return paragraph + 2;

    if (this.buffer.length > 260) {
      const comma = this.buffer.lastIndexOf(",", 220);
      if (comma >= 80) return comma + 1;
      const space = this.buffer.lastIndexOf(" ", 220);
      if (space >= 80) return space + 1;
      return 220;
    }
    return -1;
  }
}

/**
 * Split a single cleaned spoken segment into sentence-sized pieces before
 * enqueueing into the LLM stream that feeds pipelineReply.
 *
 * Why: pushing one ~280-char chunk and then closing the controller tripped
 * a race in livekit-agents' SegmentSynchronizerImpl where the audio task
 * marked itself finished before the text task had fed the synthesizer
 * (logged as `markPlaybackFinished called before text/audio input is done`
 * with `textDone:false`). Net result: the whole segment played as silence
 * — visible in /tmp/vab.log as a content tts_say lasting only ~80ms when
 * the text would normally synthesize over 2+ seconds.
 *
 * Splitting on sentence boundaries gives the framework multiple chunk
 * boundaries to align text and audio against. Empirically 252-char single
 * chunks worked while 279-char single chunks didn't, so we split anything
 * over ~150 chars and let smaller content pass through unchanged.
 */
export function splitForSpeech(text: string): string[] {
  if (text.length <= 150) return [text];
  const pieces: string[] = [];
  const re = /[.!?](?:\s|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index + 1;
    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    const piece = text.slice(start).trim();
    if (piece) pieces.push(piece);
  }
  return pieces.length > 0 ? pieces : [text];
}

export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "I'm skipping a code block.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toolStatusMessage(toolName: string): string {
  switch (toolName) {
    case "web_search":
      return "Searching the web. ";
    case "read":
    case "Read":
      return "Reading a file. ";
    case "bash":
    case "Bash":
      return "Running a command. ";
    case "edit":
    case "Edit":
      return "Editing a file. ";
    case "write":
    case "Write":
      return "Writing a file. ";
    case "fetch":
      return "Fetching a URL. ";
    default:
      return "Working on it. ";
  }
}

export const SPOKEN_TAG_PROMPT = [
  "Voice mode is active for messages that arrive through the voice/socket bridge.",
  "Wrap anything that should be spoken aloud in <spoken> tags — the user only hears what's inside those tags.",
  "Use these tags liberally: acknowledge the user's request immediately (e.g. <spoken>Sure, I'll check that now.</spoken>), give brief status updates during long tasks, and summarize your final answer.",
  "Keep <spoken> content conversational: no code, file paths, markdown, raw URLs, or long technical detail.",
  "Outside the tags, respond with full technical detail as usual — the user can read that in the transcript.",
  "Radio etiquette: keep voice acknowledgements short. The user hears a tone at the end of their turn and another at the end of yours, so no verbal 'over' or 'out' needed.",
].join("\n");
