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
    .from("documents")
    .select("object_path,file_name")
    .eq("id", id)
    .single();
  if (error || !data) return new Response("Not found", { status: 404 });
  const audit = await db.rpc("audit_document_access", { did: id });
  if (audit.error) return new Response("Not found", { status: 404 });
  const file = await db.storage
    .from("contractos-documents")
    .download(data.object_path);
  if (file.error || !file.data || file.data.size > 10485760)
    return new Response("Not found", { status: 404 });
  return new Response(await file.data.arrayBuffer(), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(data.file_name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
