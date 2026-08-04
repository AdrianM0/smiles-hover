// Run with: npm test
const assert = require("node:assert");
const test = require("node:test");
const {
  findCandidates,
  candidateAt,
  declaresSmilesColumn,
} = require("../out/scan.js");

/** The candidate texts found in a line. */
function texts(line, declaredFile = false) {
  return findCandidates(line, 4, declaredFile).map((c) => c.text);
}

/** The candidate under a cursor placed at `|`. */
function at(line) {
  const character = line.indexOf("|");
  return candidateAt(line.replace("|", ""), character)?.text;
}

test("finds SMILES in the shapes they actually appear in", () => {
  assert.deepEqual(texts('  "smiles": "CCO",'), ["CCO"]);
  assert.deepEqual(texts("CCO"), ["CCO"]);
  assert.deepEqual(texts("CCCC\tbutane"), ["CCCC"]);
  assert.deepEqual(texts("aspirin is CC(=O)Oc1ccccc1C(=O)O"), [
    "CC(=O)Oc1ccccc1C(=O)O",
  ]);
  assert.deepEqual(texts("[Na+].[Cl-] and C[C@@H](N)C(=O)O"), [
    "[Na+].[Cl-]",
    "C[C@@H](N)C(=O)O",
  ]);
});

test("English is not chemistry, and never reaches RDKit", () => {
  // Only ten element symbols are legal outside brackets, and only six letters
  // may be lowercase — which is most of a prose filter on its own.
  assert.deepEqual(texts("the reaction ran overnight in a sealed flask"), []);
  assert.deepEqual(texts("const molecule = parseSmiles(input);"), []);
  assert.deepEqual(texts("see https://example.com/paper.pdf"), []);
});

test("trims the punctuation a sentence wraps around a molecule", () => {
  assert.ok(texts("we used CC(=O)O.").includes("CC(=O)O"));
  assert.ok(texts("(see CC(=O)O)").includes("CC(=O)O"));
  assert.ok(texts("[CC(=O)O]").includes("CC(=O)O"));
  assert.ok(texts("acetic acid, CC(=O)O, was added").includes("CC(=O)O"));
});

test("ignores short tokens, which are acronyms far more often", () => {
  // Valid molecules, all of them — and none of them meant as one.
  assert.deepEqual(texts("the CNN model"), []);
  assert.deepEqual(texts("about 5 CCC of it"), []);
  assert.deepEqual(texts('"license": "ISC",'), []);
  assert.deepEqual(texts('{"lang": "CSS"}'), []);
  assert.deepEqual(texts("gene,SNP,pvalue"), []);
});

test("a line that says `smiles` means what it says", () => {
  assert.deepEqual(texts("smiles: CCO"), ["CCO"]);
  assert.deepEqual(texts('  "SMILES" = "CCO"'), ["CCO"]);
  // Alone on its line — a .smi file. Nothing else it could be.
  assert.deepEqual(texts("  CCO  "), ["CCO"]);
});

test("a call that takes a SMILES vouches for its argument", () => {
  assert.deepEqual(texts('mol = Chem.MolFromSmiles("CCO")'), ["CCO"]);
  assert.deepEqual(texts('smiles = ["CCO", "CCN"]'), ["CCO", "CCN"]);
  // The word alone isn't a claim about anything on the line.
  assert.deepEqual(texts("# convert the smiles to mols"), []);
});

test("a SMILES column header vouches for every row under it", () => {
  assert.ok(declaresSmilesColumn("smiles,name,mw"));
  assert.ok(declaresSmilesColumn('"canonical_smiles"\t"id"'));
  assert.ok(!declaresSmilesColumn("name,mw,logp"));
  // A prose line that merely mentions the word isn't a header.
  assert.ok(!declaresSmilesColumn("the smiles are in the next file"));

  assert.deepEqual(texts("CCO,ethanol,46.07"), []);
  assert.deepEqual(texts("CCO,ethanol,46.07", true), ["CCO"]);
});

test("a long bare uppercase run is a molecule, a short one is an acronym", () => {
  assert.deepEqual(texts("chain CCCCCCCCCC here"), ["CCCCCCCCCC"]);
  assert.deepEqual(texts("chain CCCCC here"), []);
});

test("skips tokens with no atoms at all", () => {
  assert.deepEqual(texts("v1.2.3 (100%)"), []);
  assert.deepEqual(texts("x = 42 + 17"), []);
});

test("skips minified lines nobody reads", () => {
  assert.deepEqual(findCandidates("CC(=O)O ".repeat(300)), []);
});

test("candidateAt returns the token the cursor is inside", () => {
  assert.equal(at('smiles = "CC(=|O)O"'), "CC(=O)O");
  assert.equal(at('|"CC(=O)O"'), undefined);
  assert.equal(at("CCO, |CC(=O)O"), "CC(=O)O");
});
