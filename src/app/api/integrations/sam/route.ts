import { timingSafeEqual } from "node:crypto";
import { workerClient } from "@/lib/supabase";
import { normalizeSam, uuid } from "@/lib/domain";
import { boundedText } from "@/lib/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const configured = process.env.INTEGRATION_TOKEN;
  const given =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  // A 32-byte random minimum token is mandatory. No cookie authentication on this route.
  if (!configured || configured.length < 43)
    return Response.json({ error: "Integration unavailable" }, { status: 503 });
  if (
    given.length > 256 ||
    Buffer.byteLength(given) !== Buffer.byteLength(configured) ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(configured))
  )
    return Response.json({ error: "Not authorized" }, { status: 401 });
  try {
    const org = uuid.parse(process.env.INGEST_ORGANIZATION_ID);
    const key = process.env.SAM_GOV_API_KEY;
    if (!key)
      return Response.json(
        { error: "Integration unavailable" },
        { status: 503 },
      );
    const date = (d: Date) =>
      `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    const url = new URL("https://api.sam.gov/opportunities/v2/search");
    url.search = new URLSearchParams({
      api_key: key,
      postedFrom: date(from),
      postedTo: date(to),
      ncode: "561720",
      limit: "100",
    }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Source unavailable");
    const records = normalizeSam(
      JSON.parse(await boundedText(response, 2000000)),
    );
    const db = workerClient();
    let ingested = 0;
    for (const data of records) {
      const { error } = await db.rpc("ingest_opportunity", { org, data });
      if (error) throw new Error("Database rejected record");
      ingested++;
    }
    return Response.json({
      ingested,
      source: "sam",
      windowDays: 7,
      limit: 100,
      paginationRequired: true,
    });
  } catch {
    // Do not log fetch exceptions: request URLs may contain SAM API credentials.
    return Response.json(
      { error: "Ingestion failed; retries are deduplicated" },
      { status: 502 },
    );
  }
}
