import Link from "next/link";
import { z } from "zod";
import { requireInternal } from "@/lib/auth";
import {
  saveCatalogPreferences,
  selectCatalogOpportunity,
} from "../../actions";
import { DateText, Result } from "../../components";
export const dynamic = "force-dynamic";
const filterSchema = z.object({
  trade: z.string().max(100).default(""),
  location: z.string().max(100).default(""),
  naics: z.string().max(20).default(""),
  set_aside: z.string().max(200).default(""),
});
export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { db, org } = await requireInternal();
  const params = await searchParams;
  const preferences = await db
    .from("organizations")
    .select("catalog_preferences")
    .eq("id", org)
    .single();
  if (preferences.error)
    return (
      <main className="page">
        <p>Préférences indisponibles. Vérifiez les migrations.</p>
      </main>
    );
  const defaults = filterSchema.safeParse(preferences.data.catalog_preferences);
  const parsed = filterSchema.safeParse(
    Object.fromEntries(
      Object.keys(filterSchema.shape).map((key) => [
        key,
        params[key] ??
          (defaults.success
            ? defaults.data[key as keyof typeof defaults.data]
            : ""),
      ]),
    ),
  );
  if (!parsed.success)
    return (
      <main className="page">
        <p>Filtres invalides.</p>
      </main>
    );
  const filters = parsed.data;
  const page = z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .safeParse(params.page ?? 0);
  if (!page.success)
    return (
      <main className="page">
        <p>Page invalide.</p>
      </main>
    );
  let query = db
    .from("opportunity_catalog")
    .select("*", { count: "exact" })
    .gt("response_deadline", new Date().toISOString());
  if (filters.trade) query = query.eq("trade", filters.trade);
  if (filters.naics) query = query.eq("naics", filters.naics);
  if (filters.set_aside) query = query.eq("set_aside", filters.set_aside);
  // Escape LIKE metacharacters; no raw PostgREST expression interpolation.
  if (filters.location)
    query = query.ilike(
      "location",
      `%${filters.location.replace(/[\\%_]/g, "\\$&")}%`,
    );
  const result = await query
    .order("response_deadline")
    .order("id")
    .range(page.data * 50, page.data * 50 + 49);
  if (result.error)
    return (
      <main className="page">
        <p>Catalogue indisponible. Vérifiez les migrations et la collecte.</p>
      </main>
    );
  const ids = result.data.map((c) => c.id);
  const dossiers = ids.length
    ? await db
        .from("opportunities")
        .select("id,catalog_id")
        .eq("organization_id", org)
        .in("catalog_id", ids)
    : { data: [], error: null };
  if (dossiers.error)
    return (
      <main className="page">
        <p>Dossiers privés indisponibles.</p>
      </main>
    );
  const pageLink = (n: number) =>
    `/workspace/catalog?${new URLSearchParams({ ...filters, page: String(n) })}`;
  return (
    <main className="page">
      <Link href="/workspace">← Mes dossiers privés</Link>
      <h1>Catalogue commun SAM.gov</h1>
      <p>
        Les annonces publiques sont collectées une seule fois. Sélectionner une
        annonce crée un dossier privé pour votre organisation.
      </p>
      <Result value={params.result} />
      <form method="get" className="panel">
        <h2>Filtres de votre organisation</h2>
        {(
          [
            ["trade", "Métier (ex. janitorial)"],
            ["location", "Zone géographique"],
            ["naics", "Code NAICS"],
            ["set_aside", "Set-aside (code exact)"],
          ] as const
        ).map(([name, label]) => (
          <label key={name}>
            {label}
            <input
              name={name}
              defaultValue={filters[name]}
              maxLength={
                name === "set_aside" ? 200 : name === "naics" ? 20 : 100
              }
            />
          </label>
        ))}
        <button type="submit">Filtrer</button>
        <button type="submit" formAction={saveCatalogPreferences}>
          Enregistrer les filtres de l’organisation
        </button>
      </form>
      <p>
        {result.count ?? 0} annonces ouvertes correspondant aux filtres. La
        collecte actuelle couvre NAICS 561720 et les sept derniers jours ; elle
        peut être incomplète.
      </p>
      {result.data.map((c) => {
        const dossier = dossiers.data?.find((d) => d.catalog_id === c.id);
        return (
          <article key={c.id} className="panel">
            <h2>{c.title}</h2>
            <p>
              {c.agency} · {c.location || "Localisation non renseignée"} · NAICS{" "}
              {c.naics || "—"}
            </p>
            <p>
              Échéance : <DateText value={c.response_deadline} />
            </p>
            <a href={c.source_url} target="_blank" rel="noopener noreferrer">
              Annonce officielle SAM.gov
            </a>
            {dossier ? (
              <p>
                <Link href={`/workspace?opportunity=${dossier.id}`}>
                  Ouvrir mon dossier privé
                </Link>
              </p>
            ) : (
              <form action={selectCatalogOpportunity}>
                <input type="hidden" name="catalog_id" value={c.id} />
                <button type="submit">Créer mon dossier privé</button>
              </form>
            )}
          </article>
        );
      })}
      {!result.data.length && (
        <p>
          Aucune annonce. Vérifiez les filtres ou lancez la collecte centrale.
        </p>
      )}
      <nav>
        {page.data > 0 && (
          <Link href={pageLink(page.data - 1)}>Page précédente</Link>
        )}{" "}
        {(page.data + 1) * 50 < (result.count ?? 0) && (
          <Link href={pageLink(page.data + 1)}>Page suivante</Link>
        )}
      </nav>
    </main>
  );
}
