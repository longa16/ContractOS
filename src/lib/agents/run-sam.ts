import { createClient } from "@supabase/supabase-js";
import { samConfiguration, safeSamDiagnostic } from "./diagnostics";
import { runSamAgent } from "./sam";

async function main() {
  const { url, key, apiKey, org } = samConfiguration(process.env);
  if (process.argv.includes("--check-config")) {
    console.log(
      "SAM configuration present and structurally valid. No network request made; credentials and services are not verified.",
    );
    return;
  }
  const db = createClient(url, key, {
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
main().catch((error: unknown) => {
  console.error(safeSamDiagnostic(error));
  process.exitCode = 1;
});
