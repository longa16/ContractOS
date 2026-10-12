import { NextRequest, NextResponse } from "next/server";
import { supabase, isConfigured } from "@/lib/supabase";
export async function GET(request: NextRequest) {
  if (!isConfigured() || !process.env.APP_ORIGIN)
    return new Response("Configuration required", { status: 503 });
  const code = request.nextUrl.searchParams.get("code");
  if (code && code.length < 2048) {
    const db = await supabase();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error)
      return NextResponse.redirect(new URL("/portal", process.env.APP_ORIGIN));
  }
  return NextResponse.redirect(
    new URL("/login?result=blocked", process.env.APP_ORIGIN),
  );
}
