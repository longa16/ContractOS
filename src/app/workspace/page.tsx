import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireInternal } from "@/lib/auth";
import { isConfigured } from "@/lib/supabase";
import { matchContractors, uuid } from "@/lib/domain";
import {
  addFact,
  addRate,
  addRequirement,
  approveGate,
  createOpportunity,
  createPricing,
  generateProposal,
  inviteContractor,
  qualifyContractor,
  recordSubmission,
  reviewRequirement,
  signOut,
  screenOpportunity,
  updateOpportunity,
  revokeApprovals,
  revokeFact,
} from "../actions";
import {
  Choice,
  DateText,
  Documents,
  Field,
  Money,
  Result,
  Upload,
} from "../components";
export const dynamic = "force-dynamic";

export default async function Workspace({
  searchParams,
}: {
  searchParams: Promise<{
    result?: string;
    view?: string;
    opportunity?: string;
  }>;
}) {
  if (!isConfigured()) redirect("/login");
  const { db, org, role, user } = await requireInternal();
  const params = await searchParams;
  const owner = role === "owner";
  const { data: organization, error: organizationError } = await db
    .from("organizations")
    .select("require_malware_scan")
    .eq("id", org)
    .single();
  if (organizationError || !organization)
    return (
      <main className="page">
        <p className="notice error">Politique de sécurité indisponible.</p>
      </main>
    );
  const view = ["opportunities", "contractors", "pricing", "audit"].includes(
    params.view || "",
  )
    ? params.view!
    : "opportunities";
  const [
    opportunities,
    contractors,
    docs,
    requirements,
    rates,
    scenarios,
    proposals,
    facts,
    approvals,
    audit,
    analyses,
  ] = await Promise.all([
    db
      .from("opportunities")
      .select("*")
      .eq("organization_id", org)
      .order("response_deadline")
      .limit(100),
    db
      .from("contractors")
      .select("*")
      .eq("organization_id", org)
      .order("company_name")
      .limit(100),
    db
      .from("documents")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(500),
    db.from("requirements").select("*").eq("organization_id", org).limit(500),
    db.from("rates").select("*").eq("organization_id", org).limit(500),
    db
      .from("pricing_scenarios")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("proposals")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(100),
    db.from("company_facts").select("*").eq("organization_id", org).limit(100),
    db
      .from("approvals")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("audit_events")
      .select("id,action,entity_id,actor_id,created_at,metadata")
      .eq("organization_id", org)
      .order("id", { ascending: false })
      .limit(100),
    db
      .from("analysis_runs")
      .select("*")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (
    [
      opportunities,
      contractors,
      docs,
      requirements,
      rates,
      scenarios,
      proposals,
      facts,
      approvals,
      audit,
      analyses,
    ].some((r) => r.error)
  )
    return (
      <main className="page">
        <div className="notice error">
          La lecture des dossiers a échoué. Vérifiez les migrations et la
          connexion Supabase.
        </div>
      </main>
    );
  const opps = opportunities.data!;
  const cs = contractors.data!;
  const ds = docs.data!;
  const rs = requirements.data!;
  const selected = uuid.safeParse(params.opportunity).success
    ? opps.find((o) => o.id === params.opportunity)
    : opps[0];
  const selectedRequirements = rs.filter(
    (r) => r.opportunity_id === selected?.id,
  );
  const selectedDocuments = ds.filter((d) => d.opportunity_id === selected?.id);
  const latestScenario = scenarios.data!.find(
    (s) => s.opportunity_id === selected?.id,
  );
  const latestProposal = proposals.data!.find(
    (p) => p.opportunity_id === selected?.id,
  );
  const blockers = selected
    ? await db.rpc("compliance_blockers", { oid: selected.id })
    : { data: [], error: null };
  const matching = selected
    ? matchContractors(cs, ds, rates.data!, selected.trade, selected.location)
    : [];
  let invitation: string | undefined;
  if (owner)
    try {
      const raw = (await cookies()).get("contractos-invite")?.value;
      const value = z
        .object({ token: z.string().max(100), org: uuid, user: uuid })
        .parse(JSON.parse(raw || "{}"));
      if (value.org === org && value.user === user.id) invitation = value.token;
    } catch {
      /* No invitation for this session. */
    }
  const closed =
    selected &&
    ["SUBMITTED", "AWARDED", "LOST", "REJECTED"].includes(selected.status);
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {owner ? "Owner" : "VA"} Command Center
          </span>
          <h1>Décisions & exceptions</h1>
          <p className="muted">
            Acquisition → qualification → offre · validations humaines
            obligatoires
          </p>
        </div>
        <form action={signOut}>
          <button className="secondary">Déconnexion</button>
        </form>
      </div>
      <Result value={params.result} />
      <div className="metrics">
        <div className="metric">
          <span>Opportunités suivies</span>
          <strong>{opps.length}</strong>
        </div>
        <div className="metric">
          <span>Échéances · 7 prochains jours</span>
          <strong>
            {
              opps.filter(
                (o) =>
                  Date.parse(o.response_deadline) >= Date.now() &&
                  Date.parse(o.response_deadline) < Date.now() + 7 * 86400000 &&
                  !["SUBMITTED", "REJECTED", "LOST", "AWARDED"].includes(
                    o.status,
                  ),
              ).length
            }
          </strong>
        </div>
        <div className="metric">
          <span>Exigences obligatoires non vérifiées</span>
          <strong>
            {rs.filter((r) => r.mandatory && r.status !== "VERIFIED").length}
          </strong>
        </div>
        <div className="metric">
          <span>Prestataires qualifiés</span>
          <strong>{cs.filter((c) => c.status === "QUALIFIED").length}</strong>
        </div>
      </div>
      <nav className="tabs">
        {[
          ["opportunities", "Opportunités"],
          ["contractors", "Réseau prestataires"],
          ["pricing", "Chiffrage & données"],
          ["audit", "Journal d’audit"],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={`/workspace?view=${key}`}
            className={view === key ? "active" : ""}
          >
            {label}
          </Link>
        ))}
      </nav>
      <p className="muted small">
        Vue MVP limitée aux 100 premiers dossiers, 500 exigences/documents et
        100 derniers événements. Les contrôles en base examinent tous les
        enregistrements.
      </p>
      {!organization.require_malware_scan && (
        <p className="notice warning">
          Politique de développement : l’antivirus obligatoire est désactivé par
          un administrateur. Ce mode ne doit pas être utilisé pour des dossiers
          réels en production.
        </p>
      )}
      {view === "opportunities" && (
        <>
          <section className="panel">
            <div className="row">
              <h2>Pipeline d’opportunités</h2>
              <span className="badge">MFA · {role.toUpperCase()}</span>
            </div>
            {opps.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Marché / agence</th>
                      <th>Source</th>
                      <th>Échéance · Europe/Paris</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opps.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link href={`/workspace?opportunity=${o.id}`}>
                            {o.title}
                          </Link>
                          <div className="muted">
                            {o.agency} · {o.solicitation_number}
                          </div>
                        </td>
                        <td>
                          {o.source}
                          {o.source_url && (
                            <div>
                              <a
                                href={
                                  o.source_url.startsWith("https://")
                                    ? o.source_url
                                    : undefined
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Consulter la source ↗
                              </a>
                            </div>
                          )}
                        </td>
                        <td>
                          <DateText value={o.response_deadline} />
                        </td>
                        <td>
                          <span
                            className={`badge ${o.status === "READY" ? "good" : ""}`}
                          >
                            {o.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">
                Aucune opportunité. Importez un premier marché ou configurez
                l’ingestion SAM.gov.
              </p>
            )}
            <details>
              <summary>Ajouter un marché · import manuel ou Maryland</summary>
              <form action={createOpportunity} className="form-grid">
                <Field label="Titre" name="title" required maxLength={500} />
                <Field
                  label="Référence de sollicitation"
                  name="solicitation_number"
                  required
                  maxLength={200}
                />
                <Choice label="Source" name="source">
                  <option value="manual">Manuel</option>
                  <option value="maryland">
                    Maryland · eMMA / source locale
                  </option>
                </Choice>
                <Field label="Agence" name="agency" maxLength={500} />
                <Field
                  label="Zone de service exacte"
                  name="location"
                  placeholder="Maryland"
                  maxLength={500}
                />
                <Field
                  label="Métier"
                  name="trade"
                  defaultValue="janitorial"
                  required
                  maxLength={100}
                />
                <Field
                  label="Date limite · UTC"
                  name="response_deadline"
                  type="datetime-local"
                  required
                />
                <Field
                  label="URL officielle HTTPS"
                  name="source_url"
                  type="url"
                  maxLength={2048}
                />
                <label className="wide">
                  Description
                  <textarea name="description" maxLength={100000} />
                </label>
                <button>Enregistrer l’opportunité</button>
              </form>
            </details>
          </section>
          {selected && (
            <>
              <section className="panel">
                <div className="row">
                  <div>
                    <span className="eyebrow">
                      Dossier · révision {selected.revision}
                    </span>
                    <h2>{selected.title}</h2>
                  </div>
                  <span className="badge">{selected.status}</span>
                </div>
                {closed ? (
                  <p className="notice">
                    Dossier clos. Les preuves et décisions restent consultables.
                  </p>
                ) : (
                  <>
                    <h3>Exceptions de conformité</h3>
                    {blockers.error ? (
                      <p className="notice error">
                        Contrôle indisponible : la soumission reste bloquée.
                      </p>
                    ) : blockers.data?.length ? (
                      <ul className="blockers">
                        {(blockers.data as string[]).map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="notice">
                        Les contrôles automatiques sont satisfaits.
                        L’autorisation finale du propriétaire reste nécessaire.
                      </p>
                    )}
                    {owner && (
                      <details>
                        <summary>Enregistrer une décision humaine</summary>
                        <form action={approveGate} className="form-grid">
                          <input
                            type="hidden"
                            name="opportunity_id"
                            value={selected.id}
                          />
                          <Choice label="Validation" name="gate">
                            <option value="pursue">
                              1 · Poursuivre le marché
                            </option>
                            <option value="rules">
                              Règles de sous-traitance / set-aside vérifiées
                            </option>
                            <option value="contractor">
                              3 · Choix du prestataire
                            </option>
                            <option value="pricing">
                              2 · Prix et stratégie de l’offre
                            </option>
                            <option value="submission">
                              4 · Package final et autorisation de soumission
                            </option>
                          </Choice>
                          <Choice label="Décision" name="decision">
                            <option value="approve">Approuver</option>
                            <option value="reject">Refuser</option>
                          </Choice>
                          <label className="wide">
                            Justification et références vérifiées
                            <textarea
                              name="rationale"
                              required
                              maxLength={4000}
                            />
                          </label>
                          <p className="muted small wide">
                            La validation des règles doit couvrir les limites de
                            sous-traitance et l’éligibilité propres à ce marché.
                            Les décisions 2, 3 et 4 s’appliquent à la révision
                            actuelle ; la validation 4 est liée au PDF exact.
                            Une décision existante reste dans l’historique.
                          </p>
                          <button>Enregistrer la décision</button>
                        </form>
                      </details>
                    )}
                  </>
                )}
                {owner && !closed && (
                  <details>
                    <summary>
                      Révoquer les validations de cette révision
                    </summary>
                    <form action={revokeApprovals} className="stack">
                      <input
                        name="opportunity_id"
                        type="hidden"
                        value={selected.id}
                      />
                      <Field
                        label="Motif"
                        name="reason"
                        required
                        maxLength={4000}
                      />
                      <button className="danger">
                        Révoquer et bloquer la soumission
                      </button>
                    </form>
                  </details>
                )}
                {!closed && (
                  <details>
                    <summary>Corriger les métadonnées du marché</summary>
                    <form action={updateOpportunity} className="form-grid">
                      <input
                        name="opportunity_id"
                        type="hidden"
                        value={selected.id}
                      />
                      <Field
                        label="Titre"
                        name="title"
                        defaultValue={selected.title}
                        required
                        maxLength={500}
                      />
                      <Field
                        label="Agence"
                        name="agency"
                        defaultValue={selected.agency}
                        maxLength={500}
                      />
                      <Field
                        label="Zone exacte"
                        name="location"
                        defaultValue={selected.location}
                        maxLength={500}
                      />
                      <Field
                        label="Métier"
                        name="trade"
                        defaultValue={selected.trade}
                        required
                        maxLength={100}
                      />
                      <Field
                        label="Date limite · UTC"
                        name="response_deadline"
                        type="datetime-local"
                        defaultValue={new Date(selected.response_deadline)
                          .toISOString()
                          .slice(0, 16)}
                        required
                      />
                      <Field
                        label="URL source HTTPS"
                        name="source_url"
                        type="url"
                        defaultValue={selected.source_url || ""}
                        maxLength={2048}
                      />
                      <Field
                        label="Set-aside · éligibilité à vérifier"
                        name="set_aside"
                        defaultValue={selected.set_aside || ""}
                        maxLength={200}
                      />
                      <label className="wide">
                        Description publique
                        <textarea
                          name="description"
                          defaultValue={selected.description}
                          maxLength={100000}
                        />
                      </label>
                      <button>
                        Enregistrer · invalide les validations suivantes
                      </button>
                    </form>
                  </details>
                )}
                <details>
                  <summary>Brief et risques IA · non vérifiés</summary>
                  {!closed && (
                    <form action={screenOpportunity} className="stack">
                      <input
                        name="opportunity_id"
                        type="hidden"
                        value={selected.id}
                      />
                      <label>
                        <input name="ai_consent" type="checkbox" required /> Je
                        confirme que les métadonnées sont publiques et
                        j’autorise leur traitement par OpenAI.
                      </label>
                      <button>Analyser l’opportunité</button>
                    </form>
                  )}
                  {analyses
                    .data!.filter((a) => a.opportunity_id === selected.id)
                    .map((a) => (
                      <div key={a.id}>
                        <p>
                          <span className="badge warn">
                            {a.kind} · BROUILLON · RÉVISION {a.revision}
                          </span>
                        </p>
                        <pre>{JSON.stringify(a.output, null, 2)}</pre>
                      </div>
                    ))}
                </details>
                <h3 className="section-title">Documents et amendements</h3>
                <Documents
                  documents={selectedDocuments}
                  owner={owner && !closed}
                  ai={!closed}
                />
                {!closed && (
                  <Upload
                    opportunityId={selected.id}
                    existing={selectedDocuments}
                  />
                )}
                <h3 className="section-title">Matrice de conformité</h3>
                {selectedRequirements.length ? (
                  selectedRequirements.map((r) => (
                    <div className="requirements" key={r.id}>
                      <div className="row">
                        <strong>{r.requirement}</strong>
                        <span
                          className={`badge ${r.status === "VERIFIED" ? "good" : "warn"}`}
                        >
                          {r.mandatory ? "OBLIGATOIRE" : "INFORMATIF"} ·{" "}
                          {r.status}
                        </span>
                      </div>
                      <p className="small muted">
                        {ds.find((d) => d.id === r.source_document_id)
                          ?.file_name || r.source_document_id}{" "}
                        · page {r.page_number} · {r.category}
                      </p>
                      <blockquote>{r.source_excerpt}</blockquote>
                      {r.evidence && (
                        <p>
                          <strong>Preuve : </strong>
                          {r.evidence}
                        </p>
                      )}
                      {!closed && (
                        <details>
                          <summary>
                            {owner
                              ? "Vérifier ou signaler un conflit"
                              : "Signaler un manque ou un conflit"}
                          </summary>
                          <form action={reviewRequirement} className="stack">
                            <input
                              type="hidden"
                              name="requirement_id"
                              value={r.id}
                            />
                            <Choice label="État" name="state">
                              <option value="MISSING">Preuve manquante</option>
                              <option value="CONFLICT">Conflit</option>
                              {owner && (
                                <option value="VERIFIED">
                                  Vérifié par le propriétaire
                                </option>
                              )}
                            </Choice>
                            <label>
                              Référence de preuve et conclusion
                              <textarea
                                name="evidence"
                                maxLength={4000}
                                defaultValue={r.evidence || ""}
                              />
                            </label>
                            <button>Enregistrer la revue</button>
                          </form>
                        </details>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="empty">
                    La matrice n’a pas encore été constituée.
                  </p>
                )}
                {!closed && (
                  <details>
                    <summary>Ajouter une exigence avec source</summary>
                    <form action={addRequirement} className="form-grid">
                      <input
                        name="opportunity_id"
                        type="hidden"
                        value={selected.id}
                      />
                      <label className="wide">
                        Exigence
                        <textarea
                          name="requirement"
                          required
                          maxLength={4000}
                        />
                      </label>
                      <Choice
                        label="Document source"
                        name="source_document_id"
                        required
                      >
                        <option value="">Sélectionner</option>
                        {selectedDocuments
                          .filter((d) =>
                            ["SOLICITATION", "AMENDMENT"].includes(d.kind),
                          )
                          .map((d) => (
                            <option value={d.id} key={d.id}>
                              {d.file_name}
                            </option>
                          ))}
                      </Choice>
                      <Field
                        label="Page"
                        name="page_number"
                        type="number"
                        min={1}
                        max={10000}
                        required
                      />
                      <Field
                        label="Catégorie"
                        name="category"
                        defaultValue="scope"
                        maxLength={100}
                      />
                      <label>
                        <input
                          name="mandatory"
                          type="checkbox"
                          defaultChecked
                        />{" "}
                        Obligatoire
                      </label>
                      <label className="wide">
                        Extrait exact de la source
                        <textarea
                          name="source_excerpt"
                          required
                          maxLength={8000}
                        />
                      </label>
                      <button>Ajouter · non vérifié</button>
                    </form>
                  </details>
                )}
              </section>
              <div className="grid">
                <section className="panel">
                  <h2>Matching explicable</h2>
                  <p className="muted small">
                    Les critères sont des filtres conservateurs. La capacité
                    finale et les contraintes du marché doivent être inspectées
                    par le propriétaire.
                  </p>
                  {matching.length ? (
                    matching.map((m) => (
                      <details key={m.id}>
                        <summary>
                          {cs.find((c) => c.id === m.id)?.company_name} ·{" "}
                          {m.eligible
                            ? "Critères satisfaits"
                            : "Points à résoudre"}
                        </summary>
                        <div className="checklist">
                          {Object.entries(m.checks).map(([key, ok]) => (
                            <span
                              key={key}
                              className={`badge ${ok ? "good" : "warn"}`}
                            >
                              {ok ? "✓" : "×"} {key}
                            </span>
                          ))}
                        </div>
                      </details>
                    ))
                  ) : (
                    <p className="empty">Aucun prestataire dans le réseau.</p>
                  )}
                </section>
                <section className="panel">
                  <h2>Chiffrage et offre</h2>
                  {latestScenario && (
                    <p>
                      Dernier scénario :{" "}
                      <strong>
                        <Money cents={latestScenario.total_cents} />
                      </strong>{" "}
                      · révision {latestScenario.revision}
                    </p>
                  )}
                  {!closed && (
                    <form action={createPricing} className="stack">
                      <input
                        name="opportunity_id"
                        type="hidden"
                        value={selected.id}
                      />
                      <Choice label="Tarif vérifié" name="rate_id" required>
                        <option value="">Sélectionner</option>
                        {rates.data!.map((r) => (
                          <option key={r.id} value={r.id}>
                            {
                              cs.find((c) => c.id === r.contractor_id)
                                ?.company_name
                            }{" "}
                            · {r.service} · {r.rate_cents} cents/{r.unit}
                          </option>
                        ))}
                      </Choice>
                      <div className="form-grid">
                        <Field
                          label="Unités"
                          name="units"
                          type="number"
                          min={1}
                          max={1000000}
                          required
                        />
                        <Field
                          label="Autres coûts · cents USD"
                          name="other_cents"
                          type="number"
                          min={0}
                          max={100000000000}
                          defaultValue={0}
                          required
                        />
                        <Field
                          label="Majoration · points de base (1500 = 15 %)"
                          name="markup"
                          type="number"
                          min={0}
                          max={100000}
                          defaultValue={1500}
                          required
                        />
                      </div>
                      <label>
                        Justificatifs des coûts : matériaux, assurance, gestion,
                        aléas…
                        <textarea name="basis" required maxLength={4000} />
                      </label>
                      <button>Créer un scénario</button>
                    </form>
                  )}
                  {!closed && (
                    <form action={generateProposal} className="section-title">
                      <input
                        name="opportunity_id"
                        type="hidden"
                        value={selected.id}
                      />
                      <button className="secondary">
                        Générer le brouillon après validation du prix
                      </button>
                    </form>
                  )}
                  {latestProposal && (
                    <details>
                      <summary>Consulter le brouillon traçable</summary>
                      <p className="notice warning">
                        Complétez les sections et formulaires hors de
                        l’application puis importez le PDF final. Ce JSON ne
                        constitue pas une offre complète.
                      </p>
                      <a href={`/api/proposals/${latestProposal.id}`} download>
                        Exporter le brouillon JSON
                      </a>
                      <pre>
                        {JSON.stringify(latestProposal.content, null, 2)}
                      </pre>
                    </details>
                  )}
                  {owner && selected.status === "READY" && (
                    <details>
                      <summary>Enregistrer une soumission effectuée</summary>
                      <form action={recordSubmission} className="stack">
                        <input
                          name="opportunity_id"
                          type="hidden"
                          value={selected.id}
                        />
                        <Field
                          label="Référence du reçu officiel · sans données sensibles"
                          name="receipt"
                          required
                          maxLength={4000}
                        />
                        <button>Consigner le reçu</button>
                      </form>
                    </details>
                  )}
                </section>
              </div>
              <section className="panel">
                <h2>Décisions du dossier</h2>
                {approvals
                  .data!.filter((a) => a.opportunity_id === selected.id)
                  .map((a) => (
                    <p key={a.id}>
                      <span className={`badge ${a.decision ? "good" : "warn"}`}>
                        {a.gate} · {a.decision ? "APPROUVÉ" : "REFUSÉ"}
                      </span>{" "}
                      · révision {a.revision} · {a.rationale}
                    </p>
                  ))}
              </section>
            </>
          )}
        </>
      )}
      {view === "contractors" && (
        <>
          {owner && (
            <section className="panel">
              <h2>Inviter un prestataire</h2>
              <form action={inviteContractor} className="form-grid">
                <Field
                  label="Adresse e-mail du destinataire"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                />
                <button>Créer une invitation · 7 jours</button>
              </form>
              {invitation && (
                <div className="notice section-title">
                  <p>
                    Code temporaire à transmettre dans une communication
                    approuvée. Visible cinq minutes ; une seule utilisation,
                    liée à l’e-mail indiqué.
                  </p>
                  <code>{invitation}</code>
                </div>
              )}
            </section>
          )}
          {cs.length ? (
            cs.map((c) => (
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
                  {c.email} · {c.trade} · {c.service_area} · Capacité :{" "}
                  {c.capacity} · {c.available ? "Disponible" : "Indisponible"}
                </p>
                <Documents
                  documents={ds.filter((d) => d.contractor_id === c.id)}
                  owner={owner}
                />
                <Upload contractorId={c.id} />
                {owner && (
                  <form action={qualifyContractor}>
                    <input type="hidden" name="contractor_id" value={c.id} />
                    <button>
                      Qualifier après vérification W-9 / assurance / licence
                    </button>
                  </form>
                )}
              </section>
            ))
          ) : (
            <p className="empty">Invitez un prestataire pour commencer.</p>
          )}
        </>
      )}
      {view === "pricing" && (
        <div className="grid">
          <section className="panel">
            <h2>Tarifs sourcés</h2>
            {rates.data!.map((r) => (
              <p key={r.id}>
                <strong>
                  {cs.find((c) => c.id === r.contractor_id)?.company_name}
                </strong>{" "}
                · {r.service} · <Money cents={r.rate_cents} />/{r.unit} · expire
                le <DateText value={r.expires_at} />
              </p>
            ))}
            {owner && (
              <details open>
                <summary>Enregistrer un tarif vérifié</summary>
                <form action={addRate} className="stack">
                  <Choice label="Prestataire" name="contractor_id" required>
                    <option value="">Sélectionner</option>
                    {cs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company_name}
                      </option>
                    ))}
                  </Choice>
                  <Choice
                    label="Devis vérifié du même prestataire"
                    name="source_document_id"
                    required
                  >
                    <option value="">Sélectionner</option>
                    {ds
                      .filter((d) => d.kind === "QUOTE" && d.verified_at)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {
                            cs.find((c) => c.id === d.contractor_id)
                              ?.company_name
                          }{" "}
                          · {d.file_name}
                        </option>
                      ))}
                  </Choice>
                  <Field
                    label="Service"
                    name="service"
                    required
                    maxLength={200}
                  />
                  <Field label="Unité" name="unit" required maxLength={100} />
                  <Field
                    label="Prix unitaire · cents USD"
                    name="rate_cents"
                    type="number"
                    min={1}
                    max={100000000000}
                    required
                  />
                  <Field
                    label="Valable jusqu’au · UTC"
                    name="expires_at"
                    type="datetime-local"
                    required
                  />
                  <button>Enregistrer</button>
                </form>
              </details>
            )}
          </section>
          <section className="panel">
            <h2>Faits vérifiés de l’entreprise</h2>
            <p className="muted small">
              Seules ces affirmations et les réponses de conformité vérifiées
              alimentent les brouillons. Ne saisissez aucune qualification non
              démontrée.
            </p>
            {facts.data!.map((f) => (
              <div className="requirements" key={f.id}>
                <strong>{f.claim}</strong>
                <p className="small muted">Source : {f.source_reference}</p>
                {f.revoked_at && (
                  <p className="badge warn">RÉVOQUÉ · {f.revoke_reason}</p>
                )}
                {owner && !f.revoked_at && (
                  <details>
                    <summary>Révoquer cette affirmation</summary>
                    <form action={revokeFact} className="stack">
                      <input name="fact_id" type="hidden" value={f.id} />
                      <Field
                        label="Motif"
                        name="reason"
                        required
                        maxLength={4000}
                      />
                      <button className="danger">
                        Révoquer et invalider les validations
                      </button>
                    </form>
                  </details>
                )}
                {f.expires_at && (
                  <p className="small">
                    Expiration : <DateText value={f.expires_at} />
                  </p>
                )}
              </div>
            ))}
            {owner && (
              <form action={addFact} className="stack">
                <label>
                  Affirmation vérifiée
                  <textarea name="claim" required maxLength={4000} />
                </label>
                <label>
                  Référence de la preuve inspectée
                  <textarea name="source" required maxLength={4000} />
                </label>
                <Field
                  label="Expiration éventuelle · UTC"
                  name="expires_at"
                  type="datetime-local"
                />
                <button>Vérifier et enregistrer</button>
              </form>
            )}
          </section>
        </div>
      )}
      {view === "audit" && (
        <section className="panel">
          <h2>Journal des actions matérielles</h2>
          <p className="muted small">
            Append-only pour les utilisateurs applicatifs. Les administrateurs
            de base restent privilégiés ; exportez les journaux vers un stockage
            immuable pour la production.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Horodatage UTC</th>
                  <th>Action</th>
                  <th>Acteur</th>
                  <th>Entité / métadonnées</th>
                </tr>
              </thead>
              <tbody>
                {audit.data!.map((a) => (
                  <tr key={a.id}>
                    <td>{a.created_at}</td>
                    <td>{a.action}</td>
                    <td>{a.actor_id || "Intégration"}</td>
                    <td>
                      <code>
                        {a.entity_id}
                        <br />
                        {JSON.stringify(a.metadata)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
