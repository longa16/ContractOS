import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export function isConfigured() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (
    !url ||
    url.includes("YOUR_PROJECT") ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
    return false;
  try {
    const target = new URL(url);
    return (
      !target.username &&
      !target.password &&
      (target.protocol === "https:" ||
        (target.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(target.hostname)))
    );
  } catch {
    return false;
  }
}
export async function supabase() {
  if (!isConfigured()) throw new Error("Supabase configuration required");
  const jar = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (values) => {
          try {
            values.forEach(({ name, value, options }) =>
              jar.set(name, value, options),
            );
          } catch {
            /* Server components are read-only; proxy refreshes sessions. */
          }
        },
      },
    },
  );
}
export function workerClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!isConfigured() || !key) throw new Error("Worker not configured");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
