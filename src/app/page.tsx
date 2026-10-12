import Link from "next/link";
import { isConfigured } from "@/lib/supabase";
export const dynamic = "force-dynamic";
export default function Home() {
  return (
    <main className="hero">
      <span className="eyebrow">
        Government contracting · Facilities services
      </span>
      <h1>
        Des opportunités aux offres.
        <br />
        Chaque décision, documentée.
      </h1>
      <p>
        Un espace de travail pour sélectionner les marchés publics, qualifier
        les prestataires et préparer des offres à partir de preuves vérifiées.
      </p>
      <div className="actions">
        <Link href="/workspace" className="button">
          Ouvrir le Command Center →
        </Link>
        <Link href="/portal">Accéder au portail prestataire</Link>
      </div>
      {!isConfigured() && (
        <div className="notice warning section-title">
          La connexion Supabase reste à configurer. Consultez le README pour
          créer la base, activer la MFA et provisionner le premier propriétaire.
        </div>
      )}
      <div className="grid">
        <section className="panel">
          <span className="eyebrow">01 · Acquisition</span>
          <h2>Une vue sur les décisions</h2>
          <p>
            Opportunités dédupliquées, échéances, exigences et blocages de
            conformité.
          </p>
        </section>
        <section className="panel">
          <span className="eyebrow">02 · Réseau</span>
          <h2>Des capacités vérifiées</h2>
          <p>
            Documents privés, tarifs sourcés et matching explicable par métier
            et zone.
          </p>
        </section>
        <section className="panel">
          <span className="eyebrow">03 · Préparation</span>
          <h2>Des offres traçables</h2>
          <p>
            Chiffrage déterministe et brouillons issus des seules données
            approuvées.
          </p>
        </section>
        <section className="panel">
          <span className="eyebrow">04 · Contrôle</span>
          <h2>Une validation humaine</h2>
          <p>
            Décisions journalisées et soumission bloquée tant qu’une condition
            reste ouverte.
          </p>
        </section>
      </div>
    </main>
  );
}
