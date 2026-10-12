import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { enrollMfa, signOut, verifyMfa } from "../actions";
export const dynamic = "force-dynamic";
export default async function Mfa({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const { db, user } = await requireUser();
  const { result } = await searchParams;
  const { data: memberships } = await db
    .from("memberships")
    .select("role")
    .eq("user_id", user.id);
  if (!memberships?.length) redirect("/portal");
  const { data: claims } = await db.auth.getClaims();
  if (claims?.claims.aal === "aal2") redirect("/workspace");
  const { data: factors, error } = await db.auth.mfa.listFactors();
  if (error)
    return (
      <main className="narrow">
        <p className="notice error">
          La MFA est indisponible. Aucun accès interne n’est autorisé.
        </p>
      </main>
    );
  let setup: { id: string; uri: string } | null = null;
  try {
    const raw = (await cookies()).get("contractos-mfa-setup")?.value;
    const parsed = z
      .object({ id: z.uuid(), uri: z.string().max(2048), user: z.uuid() })
      .parse(JSON.parse(raw || "{}"));
    if (
      parsed.user === user.id &&
      factors.all.some(
        (f) => f.id === parsed.id && f.status === "unverified",
      ) &&
      parsed.uri.startsWith("otpauth://totp/")
    )
      setup = parsed;
  } catch {
    /* Missing or expired setup cookie. */
  }
  const verified = factors.totp.filter((f) => f.status === "verified");
  const selected = verified[0]?.id || setup?.id;
  return (
    <main className="narrow">
      <span className="eyebrow">Deuxième facteur</span>
      <h1>Vérifiez votre identité</h1>
      <section className="panel">
        {result === "blocked" && (
          <p className="notice error" role="alert">
            Vérification refusée. Utilisez un code valide ou recommencez
            l’enrôlement.
          </p>
        )}
        {!selected ? (
          <>
            <p>Ajoutez ContractOS à votre application d’authentification.</p>
            <form action={enrollMfa}>
              <button>Configurer l’authentificateur</button>
            </form>
          </>
        ) : (
          <>
            {setup && !verified.length && (
              <>
                <p>
                  Ajoutez manuellement un compte TOTP avec cette clé.
                  Conservez-la uniquement dans votre authentificateur.
                </p>
                <pre>{new URL(setup.uri).searchParams.get("secret")}</pre>
                <p className="small muted">
                  Cette configuration expire après cinq minutes. Elle n’est
                  jamais envoyée à un service de QR code.
                </p>
              </>
            )}
            <form action={verifyMfa} className="stack">
              <input name="factor_id" type="hidden" value={selected} />
              <label>
                Code à six chiffres
                <input
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </label>
              <button>Vérifier et continuer</button>
            </form>
          </>
        )}
      </section>
      <form action={signOut}>
        <button className="secondary">Se déconnecter</button>
      </form>
    </main>
  );
}
