import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { acceptInvitation, signOut, updateContractor } from "../actions";
import { Documents, Field, Result, Upload } from "../components";
export const dynamic = "force-dynamic";
export default async function Portal({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  if (!isConfigured()) redirect("/login");
  const { db, user } = await requireUser();
  const { result } = await searchParams;
  const { data: memberships } = await db
    .from("memberships")
    .select("role")
    .eq("user_id", user.id);
  if (memberships?.length) redirect("/workspace");
  const [companies, documents] = await Promise.all([
    db.from("contractors").select("*").eq("user_id", user.id),
    db
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (companies.error || documents.error)
    return (
      <main className="page">
        <p className="notice error">
          Le portail est indisponible. Réessayez après vérification de la
          connexion.
        </p>
      </main>
    );
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Contractor network</span>
          <h1>Votre espace prestataire</h1>
          <p className="muted">Vos dossiers et documents de qualification.</p>
        </div>
        <form action={signOut}>
          <button className="secondary">Déconnexion</button>
        </form>
      </div>
      <Result value={result} />
      {companies.data.length === 0 ? (
        <section className="panel">
          <h2>Rejoindre ContractOS</h2>
          <p className="muted">
            Utilisez le code transmis par le donneur d’ordre. L’invitation est
            liée à votre adresse e-mail confirmée.
          </p>
          <form action={acceptInvitation} className="form-grid">
            <Field
              label="Code d’invitation"
              name="token"
              required
              maxLength={100}
            />
            <Field
              label="Raison sociale"
              name="company"
              required
              maxLength={200}
            />
            <Field
              label="Métier"
              name="trade"
              defaultValue="janitorial"
              required
              maxLength={100}
            />
            <Field
              label="Zones de service · séparées par virgules"
              name="area"
              placeholder="Maryland, DC"
              required
              maxLength={500}
            />
            <button>Rejoindre le réseau</button>
          </form>
        </section>
      ) : (
        companies.data.map((c) => (
          <section className="panel" key={c.id}>
            <div className="row">
              <h2>{c.company_name}</h2>
              <span
                className={`badge ${c.status === "QUALIFIED" ? "good" : "warn"}`}
              >
                {c.status}
              </span>
            </div>
            <p className="muted">
              {c.trade} · {c.service_area}
            </p>
            <form action={updateContractor} className="form-grid">
              <input type="hidden" name="contractor_id" value={c.id} />
              <Field
                label="Capacité disponible · unités de service"
                name="capacity"
                type="number"
                min={0}
                max={1000000}
                defaultValue={c.capacity}
                required
              />
              <label>
                <input
                  name="available"
                  type="checkbox"
                  defaultChecked={c.available}
                />{" "}
                Disponible pour une nouvelle mission
              </label>
              <button>Mettre à jour</button>
            </form>
            <h3 className="section-title">Qualification</h3>
            <p className="muted small">
              W-9, assurance et licence vérifiés sont requis par cette politique
              MVP conservatrice. Toute exemption exige une évolution contrôlée
              de la politique.
            </p>
            <Documents
              documents={documents.data.filter((d) => d.contractor_id === c.id)}
              owner={false}
            />
            <Upload contractorId={c.id} context="portal" />
          </section>
        ))
      )}
    </main>
  );
}
