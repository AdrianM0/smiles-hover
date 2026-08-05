import { blockDeclaresSmiles, findCandidates } from "./scan";

/**
 * Hovers for SMILES in cell output — DOM in a webview, not a document. Hooks
 * the built-in renderer's HTML path (`df.head()`, `_repr_html_`) and wraps the
 * molecules it drew. RDKit stays in the host, so verdicts and pictures arrive
 * by message. Plain text and stdout offer no hook, so `print(smi)` is out.
 */

/** The slice of the renderer API we use. */
interface OutputItem {
  id: string;
  mime: string;
}

interface RendererContext {
  postMessage?(message: unknown): void;
  onDidReceiveMessage?(listener: (message: HostMessage) => void): void;
  getRenderer?(id: string): Promise<BuiltinRenderer | undefined>;
}

/** The base renderer. Its hooks are the only way in; ours are never called. */
interface BuiltinRenderer {
  experimental_registerHtmlRenderingHook?(hook: {
    postRender(item: OutputItem, element: HTMLElement): void;
  }): void;
}

const BUILTIN = "vscode.builtin-renderer";

type HostMessage =
  | { type: "checked"; valid: Record<string, boolean> }
  | { type: "rendered"; smiles: string; dataUri?: string };

const HIT = "smiles-hover-hit";

/** Verdicts and pictures, per webview. Both come from the host. */
const known = new Map<string, boolean>();
const pictures = new Map<string, string | null>();

/** Held, not queried later: an output may render into a shadow root. */
const awaiting = new Set<HTMLElement>();

export async function activate(context: RendererContext): Promise<void> {
  const builtin = await context.getRenderer?.(BUILTIN);
  if (!builtin?.experimental_registerHtmlRenderingHook) return;

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
    if (hit) tooltip.hide();
  });
  window.addEventListener("scroll", () => tooltip.hide(), true);

  builtin.experimental_registerHtmlRenderingHook({
    postRender(_item, element) {
      markUp(element, context);
    },
  });
}

/** Wrap every candidate in `element`, then ask the host which are real. */
function markUp(element: HTMLElement, context: RendererContext): void {
  // No messaging, no pictures — don't promise a hover that can't arrive.
  if (!context.postMessage) return;

  const text = element.innerText ?? element.textContent ?? "";
  if (!text) return;
  const declared = blockDeclaresSmiles(text);

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Outputs re-render on every run; don't wrap twice.
      const parent = node.parentElement;
      if (parent?.closest(`.${HIT}`)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    targets.push(node as Text);
  }

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

class Tooltip {
  private readonly element: HTMLElement;
  private showing: string | undefined;

  constructor(private readonly context: RendererContext) {
    this.element = document.createElement("div");
    this.element.className = "smiles-hover-tooltip";
    this.element.hidden = true;
    document.body.append(this.element);
  }

  show(span: HTMLElement): void {
    const smiles = span.dataset.smiles;
    if (!smiles) return;
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

    const rect = span.getBoundingClientRect();
    this.element.hidden = false;
    // Below the token, or above when there's no room.
    const below = rect.bottom + 8;
    const room = window.innerHeight - below;
    this.element.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 320))}px`;
    this.element.style.top =
      room > 200 ? `${below}px` : `${Math.max(4, rect.top - 260)}px`;
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
  }

  hide(): void {
    this.element.hidden = true;
    this.showing = undefined;
  }
}

function injectStyle(): void {
  const style = document.createElement("style");
  style.textContent = `
    .${HIT} {
      text-decoration: underline dotted currentColor;
      text-underline-offset: 2px;
      cursor: help;
    }
    .smiles-hover-tooltip {
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
    .smiles-hover-tooltip img { display: block; max-width: 460px; }
  `;
  document.head.append(style);
}
