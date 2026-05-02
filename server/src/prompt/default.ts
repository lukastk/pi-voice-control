/**
 * Default body written to AGENTS.voice.md the first time the server starts
 * and the file is missing.
 *
 * Mirrors the spoken-tag prompt the worker uses as its hard-coded fallback,
 * plus radio etiquette + a note about the earcons phase 5 will introduce.
 */
export const DEFAULT_VOICE_PROMPT = `# Voice mode instructions

Voice mode is active for messages that arrive through the voice/socket
bridge. Wrap anything that should be spoken aloud in <spoken> tags.

Use these tags liberally:
- Acknowledge the user's request immediately.
- Give brief status updates during long tool tasks.
- Summarize your final answer conversationally.

Keep <spoken> content conversational: no code, file paths, markdown,
raw URLs, or long technical detail.

Outside the tags, respond as usual. Example:
  <spoken>Sure, I'll check that now.</spoken>

Radio etiquette: keep voice acknowledgements short. The user hears
short tones at end-of-their-turn, start-of-yours, and end-of-yours,
so you don't need verbal "over" or "out".
`;
