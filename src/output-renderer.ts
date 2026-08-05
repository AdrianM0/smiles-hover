import { blockDeclaresSmiles, findCandidates } from "./scan";

/**
 * Hovers for SMILES in cell output — DOM in a webview, not a document. The
 * built-in renderer only hooks HTML, so instead of waiting to be called we
 * watch the output DOM and mark up whatever appears, whichever renderer drew
 * it. RDKit stays in the host; verdicts and pictures arrive by message.
 */

interface RendererContext {
  postMessage?(message: unknown): void;
  onDidReceiveMessage?(listener: (message: HostMessage) => void): void;
}

type HostMessage =
  | { type: "checked"; valid: Record<string, boolean> }
  | { type: "rendered"; smiles: string; dataUri?: string };

const HIT = "smiles-hover-hit";
const TOOLTIP = "smiles-hover-tooltip";
const INLINE = "smiles-hover-inline";

/** Verdicts and pictures, per webview. Both come from the host. */
const known = new Map<string, boolean>();
const pictures = new Map<string, string | null>();

/** Held, not queried later: an output may render into a shadow root. */
const awaiting = new Set<HTMLElement>();

export function activate(context: RendererContext): void {
  injectStyle();
  const tooltip = new Tooltip(context);

  context.onDidReceiveMessage?.((message) => {
    if (message.type === "checked") {
      for (const [smiles, ok] of Object.entries(message.valid)) {
        known.set(smiles, ok);
      }
      settle();
    } else if (message.type === "rendered") {
      pictures.set(message.smiles, message.dataUri ?? null);
      tooltip.refresh(message.smiles);
    }
  });

  document.addEventListener("mouseover", (event) => {
    const hit = (event.target as HTMLElement | null)?.closest?.(`.${HIT}`);
    // No wait for the verdict — the picture request asks the same question.
    if (hit instanceof HTMLElement) tooltip.show(hit);
  });
  document.addEventListener("mouseout", (event) => {
    const hit = (event.target as HTMLElement | null)?.closest?.(`.${HIT}`);
    // Deferred: showing in flow reflows the notebook, which can slide the
    // token out from under the cursor and fire a spurious mouseout.
    if (hit) tooltip.hide(250);
  });
  window.addEventListener("scroll", () => tooltip.hide(), true);

  watch(context);
}

/** True while we're rewriting the DOM, so the observer ignores our own work. */
let marking = false;

/**
 * Mark up every output as it appears. Cells render lazily and get recycled on
 * scroll, so this runs for the life of the webview rather than once.
 */
function watch(context: RendererContext): void {
  const queue = new Set<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    marking = true;
    try {
      for (const element of queue) markUp(element, context);
    } finally {
      queue.clear();
      marking = false;
    }
  };

  new MutationObserver((records) => {
    if (marking) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && !node.closest(`.${HIT}`)) {
          queue.add(node);
        }
      }
    }
    if (queue.size > 0 && timer === undefined) timer = setTimeout(flush, 100);
  }).observe(document.body, { childList: true, subtree: true });

  markUp(document.body, context); // whatever rendered before we loaded
}

/** Wrap every candidate in `element`, then ask the host which are real. */
function markUp(element: HTMLElement, context: RendererContext): void {
  // No messaging, no pictures — don't promise a hover that can't arrive.
  if (!context.postMessage) return;

  const all = element.innerText ?? element.textContent ?? "";
  const declared = blockDeclaresSmiles(all);

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Outputs re-render on every run; don't wrap twice, or wrap our own UI.
      const parent = node.parentElement;
      if (parent?.closest(`.${HIT}, .${TOOLTIP}`)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

  const seen = new Set<string>();
  for (const node of targets) {
    const found = findCandidates(node.nodeValue ?? "", 4, declared);
    if (found.length === 0) continue;

    const fragment = document.createDocumentFragment();
    let at = 0;
    for (const candidate of found) {
      const before = node.nodeValue!.slice(at, candidate.start);
      if (before) fragment.append(before);

      const verdict = known.get(candidate.text);
      if (verdict === false) {
        fragment.append(candidate.text); // known not to be a molecule
        at = candidate.end;
        continue;
      }

      const span = document.createElement("span");
      span.className = HIT;
      span.dataset.smiles = candidate.text;
      span.textContent = candidate.text;
      fragment.append(span);

      if (verdict === undefined) {
        awaiting.add(span);
        seen.add(candidate.text);
      }
      at = candidate.end;
    }
    const rest = node.nodeValue!.slice(at);
    if (rest) fragment.append(rest);
    node.replaceWith(fragment);
  }

  if (seen.size > 0) {
    context.postMessage?.({ type: "check", smiles: [...seen].slice(0, 200) });
  }
}

/** Apply verdicts that have arrived to the spans still waiting on them. */
function settle(): void {
  for (const span of [...awaiting]) {
    const verdict = known.get(span.dataset.smiles ?? "");
    if (verdict === undefined) continue;
    awaiting.delete(span);
    // Not a molecule after all — put the plain text back.
    if (!verdict) span.replaceWith(span.textContent ?? "");
  }
}

/**
 * The element VS Code gave this output. The webview spans the notebook and
 * native cells are painted over it, so this box is the only safe region.
 */
function outputRoot(span: HTMLElement): HTMLElement {
  let node = span;
  while (node.parentElement && node.parentElement !== document.body) {
    node = node.parentElement;
  }
  return node;
}

/** Below this a preview says nothing, so grow the output instead. */
const MIN_PREVIEW = 120;

/**
 * Where the preview goes: inside the output's box, and only the part of that
 * box currently on screen — a truncated or scrolled output reaches well past
 * the viewport, and placing against its off-screen top puts the picture over
 * the cell above. Returns `inline` when there's no room worth using.
 */
export function fitPreview(
  span: { top: number; bottom: number; left: number },
  box: { top: number; bottom: number; left: number; right: number; width: number },
  view: { width: number; height: number }
) {
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, view.height);
  const above = span.top - top;
  const below = bottom - span.bottom;
  const room = Math.max(above, below) - 8;

  const maxW = Math.max(MIN_PREVIEW, Math.min(460, box.width - 8));
  const maxH = Math.max(MIN_PREVIEW, Math.min(240, room));
  const wanted = below >= above ? span.bottom + 4 : span.top - maxH - 4;
  const right = Math.min(box.right, view.width);

  return {
    inline: room < MIN_PREVIEW,
    maxW,
    maxH,
    top: Math.min(Math.max(top, wanted), Math.max(top, bottom - maxH)),
    left: Math.max(Math.max(box.left, 0), Math.min(span.left, right - maxW)),
  };
}

class Tooltip {
  private readonly element: HTMLElement;
  private showing: string | undefined;
  private maxW = 460;
  private maxH = 240;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: RendererContext) {
    this.element = document.createElement("div");
    this.element.className = TOOLTIP;
    this.element.hidden = true;
    document.body.append(this.element);
  }

  show(span: HTMLElement): void {
    const smiles = span.dataset.smiles;
    if (!smiles) return;
    clearTimeout(this.hideTimer);
    // Already up for this molecule: touching the DOM again would only reflow.
    if (this.showing === smiles && !this.element.hidden) return;
    this.showing = smiles;

    const picture = pictures.get(smiles);
    if (picture === undefined) {
      this.element.textContent = "Rendering…";
      this.context.postMessage?.({ type: "render", smiles });
    } else if (picture === null) {
      this.hide();
      return;
    } else {
      this.paint(picture);
    }

    this.place(span);
  }

  private place(span: HTMLElement): void {
    const root = outputRoot(span);
    const fit = fitPreview(
      span.getBoundingClientRect(),
      root.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }
    );

    this.maxW = fit.maxW;
    this.maxH = fit.maxH;
    this.element.style.maxWidth = `${fit.maxW}px`;
    this.element.hidden = false;
    this.element.classList.toggle(INLINE, fit.inline);

    if (fit.inline) {
      root.append(this.element);
    } else {
      document.body.append(this.element);
      this.element.style.top = `${fit.top}px`;
      this.element.style.left = `${fit.left}px`;
    }
    this.resize();
  }

  /** The SVG scales, so the picture shrinks to whatever room there was. */
  private resize(): void {
    const img = this.element.querySelector("img");
    if (!img) return;
    img.style.maxWidth = `${this.maxW - 12}px`;
    img.style.maxHeight = `${this.maxH - 12}px`;
  }

  /** A picture arrived; show it if it's the one on screen. */
  refresh(smiles: string): void {
    if (this.showing !== smiles || this.element.hidden) return;
    const picture = pictures.get(smiles);
    if (picture) this.paint(picture);
    else this.hide();
  }

  private paint(dataUri: string): void {
    this.element.textContent = "";
    const img = document.createElement("img");
    img.src = dataUri;
    img.alt = this.showing ?? "molecule";
    this.element.append(img);
    this.resize();
  }

  hide(delayMs = 0): void {
    clearTimeout(this.hideTimer);
    if (delayMs > 0) {
      this.hideTimer = setTimeout(() => this.hide(), delayMs);
      return;
    }
    this.element.hidden = true;
    this.element.remove();
    this.showing = undefined;
  }
}

function injectStyle(): void {
  const style = document.createElement("style");
  style.textContent = `
    .${HIT} { text-decoration: underline dotted; cursor: help; }
    .${TOOLTIP} {
      position: fixed;
      z-index: 100;
      padding: 6px;
      border-radius: 4px;
      background: #fff;
      color: #333;
      font-size: 12px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      pointer-events: none;
    }
    .${TOOLTIP} img { display: block; }
    .${TOOLTIP}.${INLINE} { position: static; margin: 4px 0; }
  `;
  document.head.append(style);
}
