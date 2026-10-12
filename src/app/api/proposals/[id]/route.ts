import { supabase, isConfigured } from "@/lib/supabase";
import { uuid } from "@/lib/domain";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isConfigured())
    return new Response("Configuration required", { status: 503 });
  const { id } = await context.params;
  if (!uuid.safeParse(id).success)
    return new Response("Not found", { status: 404 });
  const db = await supabase();
  const { data: auth, error: authError } = await db.auth.getUser();
  if (authError || !auth.user)
    return new Response("Not authorized", { status: 401 });
  const { data, error } = await db
    .from("proposals")
    .select("content,revision")
    .eq("id", id)
    .single();
  if (error || !data) return new Response("Not found", { status: 404 });
  return new Response(
    JSON.stringify({ revision: data.revision, ...data.content }, null, 2),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition":
          'attachment; filename="contractos-proposal-draft.json"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
