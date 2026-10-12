import { z } from "zod";

export const uuid = z.uuid();
export function utcDateInput(value: string): string {
  const local = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
    .parse(value);
  const iso = z.iso
    .datetime()
    .parse(`${local.length === 16 ? `${local}:00` : local}Z`);
  return new Date(iso).toISOString();
}
export const safeUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Une URL HTTPS sans identifiants est requise.");
export const opportunityInput = z
  .object({
    title: z.string().trim().min(1).max(500),
    solicitation_number: z.string().trim().min(1).max(200),
    source: z.enum(["manual", "maryland", "sam"]),
    agency: z.string().trim().max(500),
    description: z.string().max(100000),
    location: z.string().trim().max(500),
    trade: z.string().trim().min(1).max(100),
    response_deadline: z.iso.datetime({ offset: true }),
    source_url: safeUrl.optional(),
    naics: z.string().max(20).optional(),
    set_aside: z.string().max(200).optional(),
  })
  .strict();

export const extractedRequirements = z
  .object({
    requirements: z
      .array(
        z
          .object({
            requirement: z.string().trim().min(1).max(4000),
            category: z.string().trim().min(1).max(100),
            mandatory: z.boolean(),
            page_number: z.number().int().min(1),
            source_excerpt: z.string().trim().min(1).max(8000),
          })
          .strict(),
      )
      .max(100),
    risks: z.array(z.string().max(1000)).max(30),
  })
  .strict();

export type ExtractedRequirements = z.infer<typeof extractedRequirements>;
export const opportunityBrief = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    assessments: z
      .array(
        z
          .object({
            criterion: z.enum([
              "trade",
              "geography",
              "timeline",
              "set_aside",
              "subcontracting",
              "licensing",
              "insurance",
              "capacity",
            ]),
            assessment: z.enum(["POTENTIAL_FIT", "RISK", "UNKNOWN"]),
            source_excerpt: z.string().trim().max(4000),
          })
          .strict(),
      )
      .max(8),
    risks: z.array(z.string().max(1000)).max(30),
  })
  .strict();
export function validateBrief(output: unknown, source: string) {
  const result = opportunityBrief.parse(output);
  for (const item of result.assessments) {
    if (
      item.assessment !== "UNKNOWN" &&
      (!item.source_excerpt || !source.includes(item.source_excerpt))
    )
      throw new Error("Ungrounded brief");
  }
  return result;
}
// Grounding is mechanical, not a semantic guarantee. A human still reviews every item.
export function validateGrounding(
  output: unknown,
  pages: string[],
): ExtractedRequirements {
  const result = extractedRequirements.parse(output);
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const r of result.requirements) {
    const page = pages[r.page_number - 1];
    if (!page || !normalize(page).includes(normalize(r.source_excerpt)))
      throw new Error("Ungrounded extraction");
  }
  return result;
}

export function priceCents(
  rate: bigint,
  units: bigint,
  other: bigint,
  markupBps: bigint,
): bigint {
  if (
    rate < 1n ||
    units < 1n ||
    units > 1000000n ||
    other < 0n ||
    markupBps < 0n ||
    markupBps > 100000n
  )
    throw new Error("Invalid pricing");
  return ((rate * units + other) * (10000n + markupBps) + 9999n) / 10000n;
}

type MatchContractor = {
  id: string;
  trade: string;
  service_area: string;
  status: string;
  available: boolean;
  capacity: number;
};
type MatchDocument = {
  contractor_id: string | null;
  kind: string;
  verified_at: string | null;
  expires_at: string | null;
  revoked_at?: string | null;
};
type MatchRate = {
  contractor_id: string;
  expires_at: string;
  verified_by: string | null;
};
export function matchContractors(
  contractors: MatchContractor[],
  documents: MatchDocument[],
  rates: MatchRate[],
  trade: string,
  area: string,
  now = Date.now(),
) {
  return contractors.map((c) => {
    const checks: Record<string, boolean> = {
      trade: c.trade.toLowerCase() === trade.toLowerCase(),
      geography: c.service_area
        .toLowerCase()
        .split(/[,;]+/)
        .map((x) => x.trim())
        .includes(area.toLowerCase()),
      qualified: c.status === "QUALIFIED",
      available: c.available,
      capacity: c.capacity > 0,
      ...Object.fromEntries(
        ["W9", "INSURANCE", "LICENSE"].map((kind) => [
          kind,
          documents.some(
            (d) =>
              d.contractor_id === c.id &&
              d.kind === kind &&
              !!d.verified_at &&
              !d.revoked_at &&
              (!d.expires_at || Date.parse(d.expires_at) > now),
          ),
        ]),
      ),
      freshPricing: rates.some(
        (r) =>
          r.contractor_id === c.id &&
          !!r.verified_by &&
          Date.parse(r.expires_at) > now,
      ),
    };
    return { id: c.id, eligible: Object.values(checks).every(Boolean), checks };
  });
}

export function validateUpload(bytes: Uint8Array, mime: string, size: number) {
  if (size < 1 || size > 10 * 1024 * 1024 || bytes.length !== size)
    throw new Error("Invalid size");
  const pdf =
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!(
    (mime === "application/pdf" && pdf) ||
    (mime === "image/png" && png) ||
    (mime === "image/jpeg" && jpg)
  ))
    throw new Error("Invalid file signature");
}

export const samResponse = z.object({
  opportunitiesData: z
    .array(
      z.object({
        noticeId: z.string().min(1).max(200),
        solicitationNumber: z.string().max(200).nullish(),
        title: z.string().min(1).max(500),
        fullParentPathName: z.string().max(500).nullish(),
        responseDeadLine: z.string().nullish(),
        uiLink: z.string().nullish(),
        naicsCode: z.string().max(20).nullish(),
        typeOfSetAside: z.string().max(200).nullish(),
        placeOfPerformance: z.unknown().optional(),
      }),
    )
    .max(100),
  totalRecords: z.number().optional(),
});
export function normalizeSam(raw: unknown) {
  const data = samResponse.parse(raw);
  return data.opportunitiesData
    .filter(
      (x) =>
        x.responseDeadLine && !Number.isNaN(Date.parse(x.responseDeadLine)),
    )
    .map((x) =>
      opportunityInput.parse({
        title: x.title,
        solicitation_number: x.noticeId,
        source: "sam",
        agency: x.fullParentPathName ?? "",
        description: x.solicitationNumber
          ? `Solicitation: ${x.solicitationNumber}`
          : "",
        location: "",
        trade: "janitorial",
        response_deadline: new Date(x.responseDeadLine!).toISOString(),
        // Fixed trusted destination; never fetch document URLs returned by a source.
        source_url: `https://sam.gov/opp/${encodeURIComponent(x.noticeId)}/view`,
        naics: x.naicsCode ?? undefined,
        set_aside: x.typeOfSetAside ?? undefined,
      }),
    );
}
