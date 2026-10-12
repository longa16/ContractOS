"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="narrow">
      <section className="panel">
        <h1>Action indisponible</h1>
        <p>
          La connexion ou la configuration a empêché l’opération. Aucun accès
          n’est accordé par défaut.
        </p>
        <button onClick={reset}>Réessayer</button>
      </section>
    </main>
  );
}
