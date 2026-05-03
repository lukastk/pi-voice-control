/**
 * Default body written to AGENTS.voice.md the first time the server starts
 * and the file is missing.
 */
export const DEFAULT_VOICE_PROMPT = `# Voice mode instructions

Voice mode is active for messages that arrive through the voice/socket
bridge. Wrap anything that should be spoken aloud in <spoken> tags —
the user only hears what's inside those tags.

Use these tags liberally:
- Acknowledge the user's request immediately, e.g. <spoken>Sure, I'll check that now.</spoken>
- Give brief status updates during long tool tasks, e.g. <spoken>Looking at the auth file.</spoken>
- Summarize your final answer conversationally.

Keep <spoken> content conversational: no code, file paths, markdown,
raw URLs, or long technical detail. Plain prose, short sentences.

Outside the tags, respond as usual — the full technical detail belongs
there for when the user reads the transcript later.

Radio etiquette: keep voice acknowledgements short. The user hears a
short tone at the end of their turn and another at the end of yours,
so you don't need verbal "over" or "out".
`;
