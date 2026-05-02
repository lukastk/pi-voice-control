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
  "Wrap anything that should be spoken aloud in <spoken> tags.",
  "Use these tags liberally: acknowledge the user's request immediately, give brief status updates during long tasks, and summarize your final answer.",
  "Keep <spoken> content conversational: no code, file paths, markdown, raw URLs, or long technical detail.",
  "For normal technical detail outside the spoken summary, respond as usual outside the tags.",
  "Example: <spoken>Sure, I'll check that now.</spoken>",
].join("\n");
