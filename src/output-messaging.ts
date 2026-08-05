import * as vscode from "vscode";
import { SmilesRenderer } from "./renderer";

export const OUTPUT_RENDERER_ID = "smiles-hover-output";

/** Cap per output, so a huge table can't flood the host. */
const MAX_BATCH = 200;

/**
 * Serves the output renderer, which has no RDKit: it sends tokens, we say
 * which are molecules, and it asks for pictures one hover at a time.
 */
export function serveOutputRenderer(renderer: SmilesRenderer): vscode.Disposable {
  const messaging = vscode.notebooks.createRendererMessaging(
    OUTPUT_RENDERER_ID
  );

  return messaging.onDidReceiveMessage(async ({ editor, message }) => {
    if (message?.type === "check" && Array.isArray(message.smiles)) {
      const valid: Record<string, boolean> = {};
      for (const smiles of message.smiles.slice(0, MAX_BATCH)) {
        if (typeof smiles === "string") {
          valid[smiles] = await renderer.isValid(smiles);
        }
      }
      void messaging.postMessage({ type: "checked", valid }, editor);
    } else if (message?.type === "render" && typeof message.smiles === "string") {
      let dataUri: string | undefined;
      try {
        const svg = await renderer.render(message.smiles);
        dataUri =
          "data:image/svg+xml;base64," +
          Buffer.from(svg, "utf8").toString("base64");
      } catch {
        // Parses but won't draw; the renderer drops the hover.
      }
      void messaging.postMessage(
        { type: "rendered", smiles: message.smiles, dataUri },
        editor
      );
    }
  });
}
