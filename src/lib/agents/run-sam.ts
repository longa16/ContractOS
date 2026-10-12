import { createClient } from "@supabase/supabase-js";
import { uuid } from "../domain";
import { runSamAgent } from "./sam";

async function main() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
    )
  )
    throw new Error("Invalid database destination");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!key || !apiKey) throw new Error("Missing worker configuration");
  const org = uuid.parse(process.env.INGEST_ORGANIZATION_ID);
  const db = createClient(url.toString(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const result = await runSamAgent({
    apiKey,
    persist: async (data, signal) => {
      const { error } = await db
        .rpc("ingest_opportunity", { org, data })
        .abortSignal(signal);
      if (error) throw new Error("Record rejected");
    },
  });
  console.log(JSON.stringify(result));
  if (result.paginationRequired) process.exitCode = 2;
}
main().catch(() => {
  console.error(
    "SAM agent failed. Check server configuration/provider availability; replay is deduplicated.",
  );
  process.exitCode = 1;
});
