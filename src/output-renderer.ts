import { Candidate, blockDeclaresSmiles, findCandidates } from "./scan";

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
  // Says, in the webview console, that we got loaded at all.
  console.debug("SMILES Hover: output renderer active");
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
    const target = event.target as HTMLElement | null;
    const hit = target?.closest?.(`.${HIT}`);
    // No wait for the verdict — the picture request asks the same question.
    if (hit instanceof HTMLElement) {
      tooltip.show(hit);
    } else if (!tooltip.owns(target)) {
      // Only once the cursor has left the whole output. Tying this to the
      // token instead makes it flicker: showing the picture grows the output,
      // the notebook reflows, and the token slides off the cursor.
      tooltip.hide(250);
    }
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
    const found = candidatesIn(node.nodeValue ?? "", declared);
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

/**
 * Candidates in a text node, a line at a time, with offsets into the whole.
 *
 * `print()` hands over its entire output as one text node, newlines and all,
 * while the scanner is written for lines: it caps how long one may be, and a
 * token alone on its line is what vouches for a bare `CCO`. Passing the block
 * in whole made a printed list read as one enormous line of prose — and a
 * screenful of output exceeded the cap, so nothing in it was found at all.
 */
function candidatesIn(value: string, declared: boolean): Candidate[] {
  const found: Candidate[] = [];
  let offset = 0;
  for (const line of value.split("\n")) {
    for (const c of findCandidates(line, 4, declared)) {
      found.push({ ...c, start: c.start + offset, end: c.end + offset });
    }
    offset += line.length + 1; // the newline the split ate
  }
  return found;
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
 * Where to slip the picture in: straight after the token it belongs to.
 *
 * In flow, so the output grows and VS Code moves the cells below out of the
 * way — cells are painted over the webview, so a picture floating over one
 * can't be seen. After the token rather than at the end of the output, because
 * the end of a long `print()` or a scrolling output is nowhere near what the
 * cursor is on. Nothing before the token moves, so the token can't slide out
 * from under the cursor.
 *
 * A `<div>` inside a table row is foster-parented out of the table and lands
 * somewhere unrelated, so from there we climb out to the table first. A `<td>`
 * holds one fine.
 */
function anchorFor(span: HTMLElement): HTMLElement {
  let node = span;
  while (node.parentElement && TABLE_PARTS.has(node.parentElement.tagName)) {
    node = node.parentElement;
  }
  return node;
}

/** Did it land somewhere an ancestor cuts off? Unmeasurable counts as fine. */
function clipped(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  for (let n = element.parentElement; n && n !== document.body; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = n.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (rect.top >= box.bottom || rect.bottom <= box.top) return true;
    if (rect.left >= box.right || rect.right <= box.left) return true;
  }
  return false;
}

/**
 * The outermost part of this output that has a size and doesn't clip — the
 * region the cursor may roam without the picture being dismissed.
 */
function growable(span: HTMLElement): HTMLElement | undefined {
  let found: HTMLElement | undefined;
  for (let n = span.parentElement; n && n !== document.body; n = n.parentElement) {
    // A div inside a table gets foster-parented out of it, landing somewhere
    // unrelated, so those elements can't host the picture.
    if (TABLE_PARTS.has(n.tagName)) continue;
    if (n.clientHeight > 0 && getComputedStyle(n).overflowY === "visible") {
      found = n;
    }
  }
  return found;
}

const TABLE_PARTS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

class Tooltip {
  private readonly element: HTMLElement;
  /** Reused, never replaced: swapping the node relayouts the whole output. */
  private readonly img: HTMLImageElement;
  private showing: string | undefined;
  /** The output the picture was put in; the cursor may roam anywhere in it. */
  private host: HTMLElement | undefined;
  /** What the picture currently sits after. */
  private anchor: HTMLElement | undefined;
  private maxW = 460;
  private maxH = 240;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: RendererContext) {
    this.element = document.createElement("div");
    this.element.className = TOOLTIP;
    this.element.hidden = true;
    this.img = document.createElement("img");
    this.element.append(this.img);
    document.body.append(this.element);
  }

  show(span: HTMLElement): void {
    const smiles = span.dataset.smiles;
    if (!smiles) return;
    clearTimeout(this.hideTimer);
    // Already up for this molecule: touching the DOM again would only reflow.
    // `isConnected` matters — an in-flow preview goes with the output when a
    // cell re-runs or scrolls out, leaving this element detached.
    if (this.showing === smiles && !this.element.hidden && this.element.isConnected) {
      return;
    }
    this.showing = smiles;

    const picture = pictures.get(smiles);
    if (picture === undefined) {
      // Keep the previous molecule up while this one draws — blanking the box
      // collapses it, and the output resizes twice for one hover.
      this.img.style.opacity = "0.35";
      this.context.postMessage?.({ type: "render", smiles });
    } else if (picture === null) {
      this.hide();
      return;
    } else {
      this.paint(picture);
    }

    this.place(span);
  }

  /** In flow right after the token, so the notebook makes room for it. */
  private place(span: HTMLElement): void {
    const anchor = anchorFor(span);
    this.maxW = Math.min(460, Math.max(160, window.innerWidth - 8));
    this.maxH = 240;
    this.element.style.maxWidth = `${this.maxW}px`;
    this.element.hidden = false;
    this.element.classList.add(INLINE);

    // Re-inserting at the same place tears the element out and back in, which
    // is a relayout and a visible flash.
    const settled = anchor === this.anchor && this.element.isConnected;
    this.anchor = anchor;
    this.host = growable(span);
    if (!settled) {
      this.element.style.top = "";
      this.element.style.left = "";
      anchor.after(this.element);
      // Somewhere cut off after all — an output that scrolls, a cell holding
      // its overflow. Float it under the token instead.
      if (clipped(this.element)) this.float(span);
    }
    this.resize();
  }

  /** Last resort: over the output, anchored to the one honest rectangle. */
  private float(span: HTMLElement): void {
    const rect = span.getBoundingClientRect();
    this.element.classList.remove(INLINE);
    document.body.append(this.element);
    this.element.style.top = `${rect.bottom + 4}px`;
    this.element.style.left = `${Math.max(0, rect.left)}px`;
  }

  /** The SVG scales, so the picture shrinks to whatever room there was. */
  private resize(): void {
    this.img.style.maxWidth = `${this.maxW - 12}px`;
    this.img.style.maxHeight = `${this.maxH - 12}px`;
  }

  /** Is the cursor still somewhere the preview belongs to? */
  owns(node: HTMLElement | null): boolean {
    if (!node || this.element.hidden) return false;
    return !!this.host?.contains(node) || this.element.contains(node);
  }

  /** A picture arrived; show it if it's the one on screen. */
  refresh(smiles: string): void {
    if (this.showing !== smiles || this.element.hidden) return;
    const picture = pictures.get(smiles);
    if (picture) this.paint(picture);
    else this.hide();
  }

  private paint(dataUri: string): void {
    this.img.src = dataUri;
    this.img.alt = this.showing ?? "molecule";
    this.img.style.opacity = "1";
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
    this.host = undefined;
    this.anchor = undefined;
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
