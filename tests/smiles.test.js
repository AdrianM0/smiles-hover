// Run with: npm test
const assert = require("node:assert");
const test = require("node:test");
const {
  cleanSmiles,
  splitReaction,
  tokenOccurrenceAt,
} = require("../out/smiles.js");

test("cleanSmiles strips the junk a selection picks up", () => {
  assert.equal(cleanSmiles('  "CCO",  '), "CCO");
  assert.equal(cleanSmiles('\\"CCO\\"'), "CCO");
  assert.equal(cleanSmiles("`CCO`;"), "CCO");
  assert.equal(cleanSmiles("CCO\\n"), "CCO");
  assert.equal(cleanSmiles("CCO"), "CCO");
  assert.equal(cleanSmiles("   "), "");
});

test("cleanSmiles leaves valid interior punctuation alone", () => {
  assert.equal(cleanSmiles('"CC(=O)Oc1ccccc1C(=O)O"'), "CC(=O)Oc1ccccc1C(=O)O");
  assert.equal(cleanSmiles("[Na+].[Cl-]"), "[Na+].[Cl-]");
  assert.equal(cleanSmiles("C/C=C/C"), "C/C=C/C");
});

/** Offsets of `needle` under a cursor placed at `|` in `line`. */
function at(line, needle) {
  const character = line.indexOf("|");
  return tokenOccurrenceAt(line.replace("|", ""), character, needle);
}

test("tokenOccurrenceAt finds the token under the cursor", () => {
  assert.deepEqual(at('smiles = "C|CO"', "CCO"), [10, 13]);
  assert.deepEqual(at("|CCO", "CCO"), [0, 3]);
  assert.deepEqual(at("CC|O", "CCO"), [0, 3]);
});

test("tokenOccurrenceAt ignores occurrences the cursor isn't in", () => {
  assert.equal(at('|"x", "CCO"', "CCO"), undefined);
  // Cursor just past the end of the token is outside it.
  assert.equal(at("CCO|,", "CCO"), undefined);
});

test("tokenOccurrenceAt picks the occurrence the cursor is in, not the first", () => {
  assert.deepEqual(at("CCO, CCO, C|CO", "CCO"), [10, 13]);
});

test("tokenOccurrenceAt requires a whole token, not a fragment", () => {
  // A longer SMILES is a different molecule.
  assert.equal(at("CC|OCC", "CCO"), undefined);
  assert.equal(at("CC|Oc1ccccc1", "CCO"), undefined);
  // ...and prose that happens to contain the letters isn't chemistry.
  assert.equal(at("Co|coa", "Co"), undefined);
  assert.equal(at("|Cat", "C"), undefined);
  // A single-atom SMILES is fine when it stands alone.
  assert.deepEqual(at('["|C"]', "C"), [2, 3]);
});

test("tokenOccurrenceAt accepts the delimiters SMILES actually appear in", () => {
  assert.deepEqual(at("CCO\t|CCO,x", "CCO"), [4, 7]); // TSV
  assert.deepEqual(at("- C|CO (ethanol)", "CCO"), [2, 5]); // markdown list
  assert.deepEqual(at("{smiles: C|CO}", "CCO"), [9, 12]);
});

test("tokenOccurrenceAt treats bond characters as part of the token", () => {
  // Deliberately conservative: `=` is a bond, so text on either side of one
  // can be a fragment of a larger SMILES (`C=CCO`). Losing a hover in
  // `mol=CCO` is the better error than drawing ethanol for part of a diene.
  assert.equal(at("mol=C|CO", "CCO"), undefined);
});

test("tokenOccurrenceAt handles an empty needle", () => {
  assert.equal(at("|abc", ""), undefined);
});

test("splitReaction takes the RXNSMILES shape and nothing else", () => {
  assert.deepEqual(splitReaction("CCO>>CCBr"), {
    reactants: ["CCO"],
    agents: [],
    products: ["CCBr"],
  });
  assert.deepEqual(splitReaction("CCO.CC(=O)O>[H+]>CCOC(C)=O.O"), {
    reactants: ["CCO", "CC(=O)O"],
    agents: ["[H+]"],
    products: ["CCOC(C)=O", "O"],
  });
  // One `>` is a comparison, three is nothing; both sides must hold something.
  assert.equal(splitReaction("CCO>CCBr"), undefined);
  assert.equal(splitReaction("CCO>>CCBr>>CC"), undefined);
  assert.equal(splitReaction("CCO>>"), undefined);
  assert.equal(splitReaction("CCO"), undefined);
});
