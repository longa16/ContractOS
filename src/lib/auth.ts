import "server-only";
import { redirect } from "next/navigation";
import { supabase } from "./supabase";

export async function requireUser() {
  const db = await supabase();
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) redirect("/login");
  return { db, user: data.user };
}
export async function requireInternal() {
  const { db, user } = await requireUser();
  const { data: claims, error } = await db.auth.getClaims();
  if (error || claims?.claims.aal !== "aal2") redirect("/mfa");
  const { data: memberships, error: membershipError } = await db
    .from("memberships")
    .select("organization_id,role")
    .eq("user_id", user.id);
  // Explicitly reject ambiguous memberships. The MVP has one company per internal user.
  if (membershipError || memberships?.length !== 1) redirect("/portal");
  return {
    db,
    user,
    org: memberships[0].organization_id as string,
    role: memberships[0].role as "owner" | "va",
  };
}
export async function requireOwner() {
  const context = await requireInternal();
  if (context.role !== "owner") throw new Error("Not authorized");
  return context;
}
