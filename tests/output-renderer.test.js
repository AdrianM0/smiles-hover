// Run with: npm test
//
// Drives the bundled webview renderer against a DOM, standing in for the
// notebook output the built-in renderer would have drawn.
const assert = require("node:assert");
const test = require("node:test");
const { JSDOM } = require("jsdom");

/** Load the bundle fresh into an empty DOM and activate it. */
async function mount({ messaging = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body></body>`, {
    pretendToBeVisual: true,
  });
  for (const name of ["window", "document", "NodeFilter", "Node", "HTMLElement", "MutationObserver"]) {
    global[name] = name === "window" ? dom.window : dom.window[name];
  }

  const sent = [];
  let listener = () => {};
  const context = {
    postMessage: messaging ? (message) => sent.push(message) : undefined,
    onDidReceiveMessage: (fn) => (listener = fn),
  };

  // Cache-bust so each test gets its own module state.
  const url = require("node:url").pathToFileURL(
    require.resolve("../out/renderer/output.js")
  );
  const mod = await import(`${url}?t=${Math.random()}`);
  mod.activate(context);

  return {
    dom,
    sent,
    send: (message) => listener(message),
    hits: () => [...dom.window.document.querySelectorAll("[data-smiles]")],
    text: () => dom.window.document.querySelector("#o").textContent,
    /** Append an output the way VS Code does, and let the observer settle. */
    render: async (html) => {
      const host = dom.window.document.createElement("div");
      host.innerHTML = html;
      dom.window.document.body.append(host);
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  };
}

test("wraps molecules in output that appears after load", async () => {
  const out = await mount();
  await out.render(`<pre id="o">aspirin CC(=O)Oc1ccccc1C(=O)O and CCO</pre>`);

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CC(=O)Oc1ccccc1C(=O)O"]
  );
  assert.deepEqual(out.sent, [
    { type: "check", smiles: ["CC(=O)Oc1ccccc1C(=O)O"] },
  ]);
});

test("a hover works before the verdict arrives", async () => {
  // The picture request answers the same question, so a slow or lost check
  // costs nothing.
  const out = await mount();
  await out.render(`<pre id="o">smiles: CCO</pre>`);

  out.hits()[0].dispatchEvent(
    new out.dom.window.MouseEvent("mouseover", { bubbles: true })
  );
  assert.deepEqual(out.sent.at(-1), { type: "render", smiles: "CCO" });
});

test("without messaging nothing is marked up", async () => {
  // No host means no RDKit and no pictures; an underline would promise a
  // hover that can't arrive.
  const out = await mount({ messaging: false });
  await out.render(`<pre id="o">smiles: CCO</pre>`);

  assert.deepEqual(out.hits(), []);
  assert.equal(out.text(), "smiles: CCO");
});

test("a SMILES column header vouches for the cells under it", async () => {
  // What `df.head()` renders: the header is in a different node from the data.
  const out = await mount();
  await out.render(`<table id="o">
    <thead><tr><th>smiles</th><th>name</th></tr></thead>
    <tbody>
      <tr><td>CCO</td><td>ethanol</td></tr>
      <tr><td>CCN</td><td>ethylamine</td></tr>
    </tbody>
  </table>`);

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CCO", "CCN"]
  );
});

test("text the host rejects goes back to being plain text", async () => {
  // `CCC1CC` looks like SMILES and isn't — ring 1 is never closed. Only RDKit
  // knows that, and it lives in the extension host.
  const out = await mount();
  await out.render(`<pre id="o">smiles: CC(=O)O CCC1CC</pre>`);
  assert.deepEqual(out.sent[0].smiles, ["CC(=O)O", "CCC1CC"]);

  out.send({
    type: "checked",
    valid: { "CC(=O)O": true, CCC1CC: false },
  });

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CC(=O)O"]
  );
  assert.equal(out.text(), "smiles: CC(=O)O CCC1CC");
});

test("hovering a confirmed molecule asks for a picture, once", async () => {
  const out = await mount();
  await out.render(`<pre id="o">smiles: CCO</pre>`);
  out.send({ type: "checked", valid: { CCO: true } });

  const span = out.hits()[0];

  span.dispatchEvent(new out.dom.window.MouseEvent("mouseover", { bubbles: true }));
  assert.deepEqual(out.sent.at(-1), { type: "render", smiles: "CCO" });

  const tooltip = out.dom.window.document.querySelector(".smiles-hover-tooltip");
  assert.equal(tooltip.hidden, false);

  out.send({ type: "rendered", smiles: "CCO", dataUri: "data:image/svg+xml;base64,eA==" });
  assert.equal(tooltip.querySelector("img").src, "data:image/svg+xml;base64,eA==");

  // Second hover is served from the cache — no new request.
  const before = out.sent.length;
  span.dispatchEvent(new out.dom.window.MouseEvent("mouseover", { bubbles: true }));
  assert.equal(out.sent.length, before);
});

test("re-rendering the same output doesn't wrap it twice", async () => {
  const out = await mount();
  await out.render(`<pre id="o">smiles: CC(=O)O</pre>`);
  out.send({ type: "checked", valid: { "CC(=O)O": true } });
  // Re-running a cell puts the output back in the DOM.
  out.dom.window.document.body.append(out.dom.window.document.querySelector("#o"));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(out.hits().length, 1);
  assert.equal(out.text(), "smiles: CC(=O)O");
});

test("a plain-text dict repr, which no hook ever reaches", async () => {
  const out = await mount();
  await out.render(`<pre id="o">{'smiles': ['OB(O)c1ccc(Br)cc1',
  'COc1ccc2[nH]cc(CCN(C)C)c2c1'],
 'h_nmr': [[1.248593771931014e-05,
  -6.533389307594934e-05]]}</pre>`);

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["OB(O)c1ccc(Br)cc1", "COc1ccc2[nH]cc(CCN(C)C)c2c1"]
  );
});

test("with no room to float, the preview grows the output instead", async () => {
  // A one-line print has nowhere to put a picture, and anything drawn outside
  // the output's box lands behind the next cell.
  const out = await mount();
  await out.render(`<pre id="o">smiles: CCO</pre>`);
  out.send({ type: "checked", valid: { CCO: true } });
  out.hits()[0].dispatchEvent(
    new out.dom.window.MouseEvent("mouseover", { bubbles: true })
  );

  const tooltip = out.dom.window.document.querySelector(".smiles-hover-tooltip");
  assert.ok(tooltip.classList.contains("smiles-hover-inline"));
  assert.notEqual(tooltip.parentElement, out.dom.window.document.body);
});
