import { timingSafeEqual } from "node:crypto";
import { workerClient } from "@/lib/supabase";
import { uuid } from "@/lib/domain";
import { runSamAgent } from "@/lib/agents/sam";
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
    const db = workerClient();
    const result = await runSamAgent({
      apiKey: key,
      persist: async (data, signal) => {
        const { error } = await db
          .rpc("ingest_opportunity", { org, data })
          .abortSignal(signal);
        if (error) throw new Error("Database rejected record");
      },
    });
    return Response.json(result);
  } catch {
    // Do not log fetch exceptions: request URLs may contain SAM API credentials.
    return Response.json(
      { error: "Ingestion failed; retries are deduplicated" },
      { status: 502 },
    );
  }
}
