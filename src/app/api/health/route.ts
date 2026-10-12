import { isConfigured } from "@/lib/supabase";
export async function GET() {
  const configured = isConfigured();
  return Response.json(
    {
      application: "ContractOS",
      status: configured ? "configured" : "configuration_required",
      databaseConnectivity: "not_checked",
    },
    {
      status: configured ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
