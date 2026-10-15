import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classify,
  hasSupplementaryHeading,
  matchesSupplementaryName,
  scoreCandidate,
  type CandidateSignals,
} from "../src/modules/detect.ts";

function run(...pdfs: (CandidateSignals & { id: string })[]) {
  const scored = pdfs.map((p) => scoreCandidate(p.id, p));
  return classify(scored, { sortName: (c) => c.ref });
}

test("recognises common supplementary file names", () => {
  for (const name of [
    "Supplementary Information.pdf",
    "supporting_info.pdf",
    "ja1c01234_si_001.pdf",
    "41586_2020_1234_MOESM1_ESM.pdf",
    "1-s2.0-S0013468620301234-mmc1.pdf",
    "adma202001234-sup-0001-SuppMat.pdf",
    "Smith 2020 SI.pdf",
    "ESI.pdf",
    "abc1234_smith_sm.pdf",
    "pnas.2012345118.sapp.pdf",
    "Appendix A.pdf",
    "Extended Data.pdf",
  ]) {
    assert.ok(matchesSupplementaryName(name), name);
  }
});

test("does not flag ordinary article file names", () => {
  for (const name of [
    "Smith et al. - 2020 - Silicon anodes for lithium batteries.pdf",
    "Su - 2019 - Single-atom catalysts.pdf",
    "Full Text PDF",
    "Si nanowires.pdf",
    "Esmolol pharmacokinetics.pdf",
    "Supramolecular chemistry.pdf",
  ]) {
    assert.ok(!matchesSupplementaryName(name), name);
  }
});

test("ignores keywords that come from the parent title", () => {
  const parentTitle = "An appendix to the theory of SI engines";
  assert.ok(
    !matchesSupplementaryName(
      "Doe - 2021 - An appendix to the theory of SI engines.pdf",
      parentTitle,
    ),
  );
});

test("detects SI headings but not pointers to the SI", () => {
  assert.ok(
    hasSupplementaryHeading(
      "Supporting Information\nHighly efficient catalysts\nJohn Doe",
    ),
  );
  assert.ok(
    hasSupplementaryHeading("Electronic Supplementary Information (ESI) for"),
  );
  assert.ok(
    !hasSupplementaryHeading(
      "Abstract ... Supporting Information is available free of charge",
    ),
  );
  // ACS article front page lists "Supporting Information" as a link.
  assert.ok(
    !hasSupplementaryHeading(
      "Cite This: J. Am. Chem. Soc. 2021 Read Online ACCESS Metrics & More Article Recommendations Supporting Information ABSTRACT:",
    ),
  );
});

test("classic case: Full Text PDF + named SI", () => {
  const r = run(
    { id: "main", title: "Full Text PDF", filename: "Doe - 2021 - Catalysis.pdf" },
    { id: "si", title: "Supporting Information", filename: "ja1c01234_si_001.pdf" },
  );
  assert.equal(r.confident, true);
  assert.equal(r.main?.ref, "main");
  assert.deepEqual(r.supplementary.map((s) => s.ref), ["si"]);
});

test("several SI files are all merged, in natural order", () => {
  const r = run(
    { id: "si_010", title: "SI 10", filename: "x_si_010.pdf" },
    { id: "main", title: "Full Text PDF", filename: "Doe.pdf" },
    { id: "si_002", title: "SI 2", filename: "x_si_002.pdf" },
  );
  assert.equal(r.confident, true);
  assert.equal(r.main?.ref, "main");
  assert.deepEqual(r.supplementary.map((s) => s.ref), ["si_002", "si_010"]);
});

test("content alone can identify the SI", () => {
  const r = run(
    {
      id: "main",
      title: "Doe 2021",
      filename: "a.pdf",
      text: "Highly efficient catalysts. Abstract: We report ... doi 10.1/xyz",
      parentDOI: "10.1/XYZ",
    },
    {
      id: "si",
      title: "Doe 2021 (1)",
      filename: "b.pdf",
      text: "Supporting Information for Highly efficient catalysts. Figure S1. Figure S2. Table S1. Figure S3. Scheme S1.",
    },
  );
  assert.equal(r.confident, true);
  assert.equal(r.main?.ref, "main");
});

test("two look-alike PDFs (preprint + published) are never merged silently", () => {
  const r = run(
    { id: "a", title: "Full Text PDF", filename: "a.pdf" },
    { id: "b", title: "Accepted Version", filename: "b.pdf" },
  );
  assert.equal(r.confident, false);
});

test("two main candidates plus an SI is ambiguous", () => {
  const r = run(
    { id: "a", title: "Full Text PDF", filename: "a.pdf" },
    { id: "b", title: "Submitted Version", filename: "b.pdf" },
    { id: "si", title: "Supplementary Information", filename: "si.pdf" },
  );
  assert.equal(r.confident, false);
  assert.deepEqual(r.supplementary.map((s) => s.ref), ["si"]);
});

test("everything looking supplementary is ambiguous", () => {
  const r = run(
    { id: "a", title: "SI part 1", filename: "a_si_1.pdf" },
    { id: "b", title: "SI part 2", filename: "b_si_2.pdf" },
  );
  assert.equal(r.confident, false);
});

test("weak evidence alone does not trigger a merge", () => {
  // Only the file name hints at SI, and the other PDF has no main-title
  // signal: the gap is below the safety margin.
  const r = run(
    { id: "a", title: "Doe 2021", filename: "a.pdf", text: "Some text" },
    { id: "b", title: "Doe 2021 (1)", filename: "b_si_.pdf", text: "Abstract: blah" },
  );
  assert.equal(r.confident, false);
});
