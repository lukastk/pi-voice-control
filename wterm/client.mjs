import { WTerm } from "@wterm/dom";
import { WebSocketTransport } from "@wterm/core";

const el = document.getElementById("terminal");
const term = new WTerm(el, { autoResize: true });
await term.init();

// iOS Safari: manually resize container when virtual keyboard opens
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    document.documentElement.style.height = `${window.visualViewport.height}px`;
  });
}

const proto = location.protocol === "https:" ? "wss:" : "ws:";
const transport = new WebSocketTransport({
  url: `${proto}//${location.host}/ws`,
  onData: (data) => term.write(data),
  onOpen: () => transport.send(`\x1b[RESIZE:${term.cols};${term.rows}]`),
  onClose: () =>
    term.write("\r\n\x1b[90m[session ended — reconnecting…]\x1b[0m\r\n"),
});

transport.connect();

// Extra keys bar — modifier state
let ctrlActive = false;
let altActive = false;
const ctrlBtn = document.querySelector('[data-key="ctrl"]');
const altBtn = document.querySelector('[data-key="alt"]');

function send(data) {
  if (ctrlActive) {
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      // Ctrl+letter: map to ASCII control character (code & 0x1f)
      if (code >= 64 && code <= 127) {
        data = String.fromCharCode(code & 0x1f);
      }
    }
    ctrlActive = false;
    ctrlBtn.classList.remove("active");
  }
  if (altActive) {
    data = "\x1b" + data;
    altActive = false;
    altBtn.classList.remove("active");
  }
  transport.send(data);
}

term.onData = (data) => send(data);
term.onResize = (cols, rows) =>
  transport.send(`\x1b[RESIZE:${cols};${rows}]`);

// Arrow key escape sequences (normal vs application cursor mode)
function arrowSeq(letter) {
  return term.bridge?.cursorKeysApp()
    ? `\x1bO${letter}`
    : `\x1b[${letter}`;
}

function adjustFontSize(delta) {
  const current = parseFloat(
    getComputedStyle(el).getPropertyValue("--term-font-size"),
  );
  const newSize = Math.max(8, Math.min(32, current + delta));
  el.style.setProperty("--term-font-size", `${newSize}px`);

  // Measure character dimensions with a clean probe (no .term-row class)
  // to avoid being constrained by the old --term-row-height CSS value.
  const grid = el.querySelector(".term-grid");
  const probe = document.createElement("div");
  probe.style.cssText =
    "visibility:hidden;position:absolute;white-space:pre;" +
    `font-family:var(--term-font-family);font-size:${newSize}px;` +
    "line-height:var(--term-line-height)";
  probe.textContent = "W";
  grid.appendChild(probe);
  const charWidth = probe.getBoundingClientRect().width;
  const rowHeight = Math.ceil(probe.getBoundingClientRect().height);
  probe.remove();

  if (charWidth > 0 && rowHeight > 0) {
    el.style.setProperty("--term-row-height", `${rowHeight}px`);
    term._rowHeight = rowHeight;

    const style = getComputedStyle(el);
    const w =
      el.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    const h =
      el.clientHeight -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    const cols = Math.max(1, Math.floor(w / charWidth));
    const rows = Math.max(1, Math.floor(h / rowHeight));
    term.resize(cols, rows);
  }
}

const keyActions = {
  esc: () => send("\x1b"),
  tab: () => send("\t"),
  ctrl: () => {
    ctrlActive = !ctrlActive;
    ctrlBtn.classList.toggle("active", ctrlActive);
    if (ctrlActive) {
      altActive = false;
      altBtn.classList.remove("active");
    }
  },
  alt: () => {
    altActive = !altActive;
    altBtn.classList.toggle("active", altActive);
    if (altActive) {
      ctrlActive = false;
      ctrlBtn.classList.remove("active");
    }
  },
  up: () => send(arrowSeq("A")),
  down: () => send(arrowSeq("B")),
  left: () => send(arrowSeq("D")),
  right: () => send(arrowSeq("C")),
  "font-down": () => adjustFontSize(-1),
  "font-up": () => adjustFontSize(1),
};

// Mouse wheel → SGR mouse escape sequences so tmux mouse mode works.
// Button 64 = scroll up, 65 = scroll down in SGR encoding.
el.addEventListener("wheel", (e) => {
  e.preventDefault();
  const style = getComputedStyle(el);
  const padLeft = parseFloat(style.paddingLeft);
  const padTop = parseFloat(style.paddingTop);
  const charWidth =
    (el.clientWidth - padLeft - parseFloat(style.paddingRight)) / term.cols;
  const rowHeight =
    (el.clientHeight - padTop - parseFloat(style.paddingBottom)) / term.rows;
  const col = Math.floor((e.clientX - el.getBoundingClientRect().left - padLeft) / charWidth);
  const row = Math.floor((e.clientY - el.getBoundingClientRect().top - padTop) / rowHeight);
  const x = Math.max(0, Math.min(col, term.cols - 1));
  const y = Math.max(0, Math.min(row, term.rows - 1));
  const btn = e.deltaY < 0 ? 64 : 65;
  // SGR mouse: \x1b[<btn;col;rowM
  transport.send(`\x1b[<${btn};${x + 1};${y + 1}M`);
}, { passive: false });

// Touch scroll → mouse scroll sequences for mobile
let touchStartY = null;
el.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) touchStartY = e.touches[0].clientY;
}, { passive: true });
el.addEventListener("touchmove", (e) => {
  if (touchStartY === null || e.touches.length !== 1) return;
  const dy = touchStartY - e.touches[0].clientY;
  const threshold = term._rowHeight || 17;
  if (Math.abs(dy) >= threshold) {
    const btn = dy > 0 ? 65 : 64;
    const lines = Math.floor(Math.abs(dy) / threshold) * 3;
    for (let i = 0; i < lines; i++) {
      transport.send(`\x1b[<${btn};1;1M`);
    }
    touchStartY = e.touches[0].clientY;
    e.preventDefault();
  }
}, { passive: false });
el.addEventListener("touchend", () => { touchStartY = null; }, { passive: true });

// Prevent buttons from stealing terminal focus; handle clicks
const bar = document.getElementById("extra-keys");
bar.addEventListener("pointerdown", (e) => e.preventDefault());
bar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-key]");
  if (!btn) return;
  const action = keyActions[btn.dataset.key];
  if (action) action();
});
