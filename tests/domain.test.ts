import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchContractors,
  normalizeSam,
  priceCents,
  safeUrl,
  validateGrounding,
  validateUpload,
  validateBrief,
  utcDateInput,
} from "../src/lib/domain";
import { boundedText } from "../src/lib/http";

test("Pricing rounds upward using integer cents, without float errors", () => {
  assert.equal(priceCents(1234n, 10n, 1000n, 1500n), 15341n);
  assert.equal(priceCents(1n, 1n, 0n, 1n), 2n);
  assert.throws(() => priceCents(100n, 0n, 0n, 0n));
  assert.throws(() => priceCents(100n, 1n, -1n, 0n));
});
test("UTC-labelled form dates are independent of the host timezone and reject rolled-over dates", () => {
  assert.equal(utcDateInput("2099-01-01T12:00"), "2099-01-01T12:00:00.000Z");
  assert.throws(() => utcDateInput("2026-02-29T12:00"));
  assert.throws(() => utcDateInput("2099-01-01T12:00+02:00"));
});
test("AI output must have a real page and verbatim source; extra permissions rejected", () => {
  const item = {
    requirement: "Insurance",
    category: "insurance",
    mandatory: true,
    page_number: 1,
    source_excerpt: "Insurance required.",
  };
  const result = validateGrounding({ requirements: [item], risks: [] }, [
    "Insurance required.",
  ]);
  assert.equal(result.requirements[0].mandatory, true);
  assert.throws(() =>
    validateGrounding(
      { requirements: [{ ...item, source_excerpt: "   " }], risks: [] },
      ["Insurance required."],
    ),
  );
  assert.throws(() =>
    validateGrounding(
      { requirements: [{ ...item, page_number: 2 }], risks: [] },
      ["Insurance required."],
    ),
  );
  assert.throws(() =>
    validateGrounding(
      {
        requirements: [{ ...item, source_excerpt: "Invented certificate" }],
        risks: [],
      },
      ["Insurance required."],
    ),
  );
  assert.throws(() =>
    validateGrounding(
      { requirements: [{ ...item, status: "VERIFIED" }], risks: [] },
      ["Insurance required."],
    ),
  );
});
test("Only HTTPS links without embedded credentials", () => {
  for (const input of [
    "javascript:alert(1)",
    "http://localhost/a",
    "https://user:secret@example.com",
    "file:///etc/passwd",
  ])
    assert.equal(safeUrl.safeParse(input).success, false);
  assert.equal(safeUrl.safeParse("https://sam.gov/opp/123/view").success, true);
});
test("Opportunity brief keeps unsupported factors unknown and requires grounded assessments", () => {
  assert.doesNotThrow(() =>
    validateBrief(
      {
        summary: "Draft",
        assessments: [
          { criterion: "insurance", assessment: "UNKNOWN", source_excerpt: "" },
        ],
        risks: [],
      },
      "Cleaning",
    ),
  );
  assert.throws(() =>
    validateBrief(
      {
        summary: "Draft",
        assessments: [
          {
            criterion: "insurance",
            assessment: "POTENTIAL_FIT",
            source_excerpt: "Invented insured contractor",
          },
        ],
        risks: [],
      },
      "Cleaning",
    ),
  );
});
test("Upload size and signature checks reject MIME spoofing and unsupported active formats", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n");
  assert.doesNotThrow(() => validateUpload(pdf, "application/pdf", pdf.length));
  assert.throws(() =>
    validateUpload(
      new TextEncoder().encode("<script>alert(1)</script>"),
      "application/pdf",
      25,
    ),
  );
  assert.throws(() => validateUpload(pdf, "text/html", pdf.length));
  assert.throws(() => validateUpload(pdf, "application/pdf", 10485761));
});
test("Matching explains each blocker and never assumes qualification or geographic fit", () => {
  const c = {
    id: "a",
    trade: "janitorial",
    service_area: "Maryland, DC",
    status: "QUALIFIED",
    available: true,
    capacity: 100,
  };
  const docs = ["W9", "INSURANCE", "LICENSE"].map((kind) => ({
    contractor_id: "a",
    kind,
    verified_at: "2026-01-01",
    expires_at: "2099-01-01",
  }));
  const rates = [
    { contractor_id: "a", expires_at: "2099-01-01", verified_by: "owner" },
  ];
  assert.equal(
    matchContractors([c], docs, rates, "janitorial", "Maryland")[0].eligible,
    true,
  );
  const result = matchContractors(
    [c],
    docs.slice(0, 2),
    rates,
    "janitorial",
    "Virginia",
  )[0];
  assert.equal(result.eligible, false);
  assert.equal(result.checks.geography, false);
  assert.equal(result.checks.LICENSE, false);
});
test("SAM normalization uses notice ID for deduplication and ignores source-provided fetch URLs", () => {
  const data = normalizeSam({
    opportunitiesData: [
      {
        noticeId: "abc123",
        solicitationNumber: "RFQ-1",
        title: "Cleaning",
        responseDeadLine: "2099-01-01T12:00:00Z",
        uiLink: "http://169.254.169.254/latest/meta-data/",
      },
    ],
  });
  assert.equal(data[0].solicitation_number, "abc123");
  assert.equal(data[0].source_url, "https://sam.gov/opp/abc123/view");
});
test("Outbound response size is bounded during streaming", async () => {
  assert.equal(await boundedText(new Response("small"), 100), "small");
  await assert.rejects(
    boundedText(new Response("too much"), 2),
    /Response too large/,
  );
});
