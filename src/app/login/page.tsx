import { isConfigured } from "@/lib/supabase";
import { register, signIn } from "../actions";
export const dynamic = "force-dynamic";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const { result } = await searchParams;
  return (
    <main className="narrow">
      <span className="eyebrow">Accès sécurisé</span>
      <h1>Bienvenue sur ContractOS</h1>
      <p className="muted">
        La MFA est obligatoire pour le Command Center. Les prestataires accèdent
        uniquement à leurs dossiers.
      </p>
      {!isConfigured() ? (
        <div className="notice warning">
          Supabase n’est pas configuré. Suivez les instructions du README avant
          de créer des comptes.
        </div>
      ) : (
        <section className="panel">
          {result === "blocked" && (
            <p className="notice error" role="alert">
              Connexion ou action refusée. Vérifiez les informations et
              réessayez.
            </p>
          )}
          {result === "confirm" && (
            <p className="notice">
              Si l’inscription peut aboutir, vous recevrez un e-mail de
              confirmation.
            </p>
          )}
          <form action={signIn} className="stack">
            <div>
              <label htmlFor="email">E-mail</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
              />
            </div>
            <div>
              <label htmlFor="password">Mot de passe</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </div>
            <button>Se connecter</button>
          </form>
          <details className="auth-option">
            <summary>Créer un compte prestataire</summary>
            <p className="muted small">
              Après confirmation de votre e-mail, le code d’invitation est
              nécessaire pour rejoindre l’entreprise. L’inscription ne donne
              aucun droit interne.
            </p>
            <form action={register} className="stack">
              <label>
                E-mail
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="username"
                />
              </label>
              <label>
                Mot de passe · 14 caractères minimum
                <input
                  name="password"
                  type="password"
                  required
                  minLength={14}
                  maxLength={128}
                  autoComplete="new-password"
                />
              </label>
              <button>Créer mon compte</button>
            </form>
          </details>
        </section>
      )}
    </main>
  );
}
