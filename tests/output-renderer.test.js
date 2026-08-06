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
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

  const sent = [];
  let listener = () => {};
  const context = {
    // Diagnostics are noise here.
    postMessage: messaging
      ? (message) => message.type !== "debug" && sent.push(message)
      : undefined,
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

test("the preview goes in the output, so the notebook makes room", async () => {
  // Cells are painted over the webview, so the only way to see the whole
  // picture is to grow the output and let VS Code push them down.
  const out = await mount();
  await out.render(`<div id="o"><pre>smiles: CCO</pre></div>`);
  // jsdom lays nothing out, so give the output a height to be found by.
  Object.defineProperty(out.dom.window.document.querySelector("#o"), "clientHeight", {
    value: 40,
  });
  out.send({ type: "checked", valid: { CCO: true } });
  out.hits()[0].dispatchEvent(
    new out.dom.window.MouseEvent("mouseover", { bubbles: true })
  );

  const doc = out.dom.window.document;
  const tooltip = doc.querySelector(".smiles-hover-tooltip");
  assert.ok(tooltip.classList.contains("smiles-hover-inline"));
  assert.ok(doc.querySelector("#o").contains(tooltip), "inside the output");
});

test("the preview survives the token moving off the cursor", async () => {
  // Showing the picture grows the output and the notebook reflows, so the
  // token slides away and the pointer lands on other parts of the output.
  // Hiding on that is what made it flicker and vanish.
  const out = await mount();
  await out.render(`<div id="o"><pre>smiles: CCO</pre><span id="elsewhere">x</span></div>`);
  const doc = out.dom.window.document;
  Object.defineProperty(doc.querySelector("#o"), "clientHeight", { value: 40 });
  out.send({ type: "checked", valid: { CCO: true } });

  const over = (el) =>
    el.dispatchEvent(new out.dom.window.MouseEvent("mouseover", { bubbles: true }));
  over(out.hits()[0]);
  assert.ok(doc.querySelector(".smiles-hover-tooltip"));

  // The cursor is now over the output, but no longer the token.
  over(doc.querySelector("#elsewhere"));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(doc.querySelector(".smiles-hover-tooltip"), "still up");

  // Leaving the output entirely does close it.
  over(doc.body);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(doc.querySelector(".smiles-hover-tooltip"), null);
});

test("the preview comes back after its output is re-rendered", async () => {
  // An in-flow preview lives inside the output, so a cell re-run or a scroll
  // takes it with them — hovering the same molecule must still work.
  const out = await mount();
  await out.render(`<pre id="o">smiles: CCO</pre>`);
  out.send({ type: "checked", valid: { CCO: true } });
  const over = (span) =>
    span.dispatchEvent(new out.dom.window.MouseEvent("mouseover", { bubbles: true }));
  over(out.hits()[0]);

  const doc = out.dom.window.document;
  assert.ok(doc.querySelector(".smiles-hover-tooltip"));
  doc.querySelector("#o").parentElement.remove(); // the output goes away

  await out.render(`<pre id="o">smiles: CCO</pre>`);
  over(out.hits()[0]);
  assert.ok(doc.querySelector(".smiles-hover-tooltip"), "shown again");
});

test("switching molecules swaps the picture without rebuilding it", async () => {
  // Clearing the box or re-appending it relayouts the output, which reads as
  // a flicker on every move between two molecules.
  const out = await mount();
  await out.render(`<div id="o"><pre>smiles: CCO CCN</pre></div>`);
  const doc = out.dom.window.document;
  Object.defineProperty(doc.querySelector("#o"), "clientHeight", { value: 40 });
  out.send({ type: "checked", valid: { CCO: true, CCN: true } });
  const over = (el) =>
    el.dispatchEvent(new out.dom.window.MouseEvent("mouseover", { bubbles: true }));

  over(out.hits()[0]);
  out.send({ type: "rendered", smiles: "CCO", dataUri: "data:image/svg+xml;base64,QQ==" });
  const img = doc.querySelector(".smiles-hover-tooltip img");

  over(out.hits()[1]);
  out.send({ type: "rendered", smiles: "CCN", dataUri: "data:image/svg+xml;base64,Qg==" });

  assert.equal(doc.querySelector(".smiles-hover-tooltip img"), img, "same <img> node");
  assert.equal(img.src, "data:image/svg+xml;base64,Qg==", "just a new src");
  assert.equal(doc.querySelectorAll(".smiles-hover-tooltip").length, 1);
});

test("a reaction in output is one hit, not two molecules", async () => {
  const out = await mount();
  await out.render(`<pre id="o">step 1: CCO.CC(=O)O>[H+]>CCOC(C)=O.O</pre>`);

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CCO.CC(=O)O>[H+]>CCOC(C)=O.O"]
  );
});
