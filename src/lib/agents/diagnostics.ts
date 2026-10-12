export class SamAgentError extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic);
  }
}
export function samConfiguration(env: Record<string, string | undefined>) {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SAM_GOV_API_KEY",
  ] as const;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new SamAgentError(
      `Missing configuration: ${missing.join(", ")}. Set these in .env.local or the server environment.`,
    );
  let url: URL;
  try {
    url = new URL(env.NEXT_PUBLIC_SUPABASE_URL!);
  } catch {
    throw new SamAgentError("Invalid NEXT_PUBLIC_SUPABASE_URL.");
  }
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
    )
  )
    throw new SamAgentError(
      "NEXT_PUBLIC_SUPABASE_URL requires HTTPS, except localhost development.",
    );
  return {
    url: url.toString(),
    key: env.SUPABASE_SERVICE_ROLE_KEY!,
    apiKey: env.SAM_GOV_API_KEY!,
  };
}
export function safeSamDiagnostic(error: unknown) {
  return error instanceof SamAgentError
    ? error.diagnostic
    : "SAM agent failed unexpectedly. No raw provider details are printed; check runtime and server configuration.";
}
