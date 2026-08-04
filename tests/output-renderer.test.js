// Run with: npm test
//
// Drives the bundled webview renderer against a DOM, standing in for the
// notebook output the built-in renderer would have drawn.
const assert = require("node:assert");
const test = require("node:test");
const { JSDOM } = require("jsdom");

/** Load the bundle fresh, with a DOM in place, and activate it. */
async function mount(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    pretendToBeVisual: true,
  });
  for (const name of ["window", "document", "NodeFilter", "Node", "HTMLElement"]) {
    global[name] = name === "window" ? dom.window : dom.window[name];
  }

  const sent = [];
  let listener = () => {};
  const context = {
    postMessage: (message) => sent.push(message),
    onDidReceiveMessage: (fn) => (listener = fn),
  };

  // Cache-bust so each test gets its own module state.
  const url = require("node:url").pathToFileURL(
    require.resolve("../out/renderer/output.js")
  );
  const mod = await import(`${url}?t=${Math.random()}`);
  const renderer = mod.activate(context);

  return {
    dom,
    sent,
    renderer,
    send: (message) => listener(message),
    hits: () => [...dom.window.document.querySelectorAll("[data-smiles]")],
    render: (selector) =>
      renderer.renderOutputItem(
        { id: "1", mime: "text/plain" },
        dom.window.document.querySelector(selector)
      ),
  };
}

test("wraps molecules in printed output and asks the host about them", async () => {
  const out = await mount(
    `<pre id="o">aspirin CC(=O)Oc1ccccc1C(=O)O and CCO</pre>`
  );
  out.render("#o");

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CC(=O)Oc1ccccc1C(=O)O"]
  );
  assert.deepEqual(out.sent, [
    { type: "check", smiles: ["CC(=O)Oc1ccccc1C(=O)O"] },
  ]);
  // Nothing is hoverable until the host has vouched for it.
  assert.ok(out.hits()[0].className.includes("pending"));
});

test("a SMILES column header vouches for the cells under it", async () => {
  // What `df.head()` renders: the header is in a different node from the data.
  const out = await mount(`<table id="o">
    <thead><tr><th>smiles</th><th>name</th></tr></thead>
    <tbody>
      <tr><td>CCO</td><td>ethanol</td></tr>
      <tr><td>CCN</td><td>ethylamine</td></tr>
    </tbody>
  </table>`);
  out.render("#o");

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CCO", "CCN"]
  );
});

test("text the host rejects goes back to being plain text", async () => {
  // `CCC1CC` looks like SMILES and isn't — ring 1 is never closed. Only RDKit
  // knows that, and it lives in the extension host.
  const out = await mount(`<pre id="o">smiles: CC(=O)O CCC1CC</pre>`);
  out.render("#o");
  assert.deepEqual(out.sent[0].smiles, ["CC(=O)O", "CCC1CC"]);

  out.send({
    type: "checked",
    valid: { "CC(=O)O": true, CCC1CC: false },
  });

  assert.deepEqual(
    out.hits().map((s) => s.dataset.smiles),
    ["CC(=O)O"]
  );
  assert.equal(
    out.dom.window.document.querySelector("#o").textContent,
    "smiles: CC(=O)O CCC1CC"
  );
});

test("hovering a confirmed molecule asks for a picture, once", async () => {
  const out = await mount(`<pre id="o">smiles: CCO</pre>`);
  out.render("#o");
  out.send({ type: "checked", valid: { CCO: true } });

  const span = out.hits()[0];
  assert.ok(!span.className.includes("pending"));

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
  const out = await mount(`<pre id="o">smiles: CC(=O)O</pre>`);
  out.render("#o");
  out.send({ type: "checked", valid: { "CC(=O)O": true } });
  out.render("#o"); // cells re-render on every execution

  assert.equal(out.hits().length, 1);
  assert.equal(
    out.dom.window.document.querySelector("#o").textContent,
    "smiles: CC(=O)O"
  );
});
