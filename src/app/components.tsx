import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import Link from "next/link";
import {
  extractRequirements,
  uploadDocument,
  verifyDocument,
  revokeDocument,
  scanDocument,
} from "./actions";
export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label>
      {label}
      <input {...props} />
    </label>
  );
}
export function Choice({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label>
      {label}
      <select aria-label={label} {...props}>
        {children}
      </select>
    </label>
  );
}
export function Result({ value }: { value?: string }) {
  if (value === "blocked")
    return (
      <div role="alert" className="notice error">
        Action refusée. Vérifiez les droits, les champs, les doublons et les
        prérequis de conformité. Aucun contournement des contrôles n’est
        autorisé.
      </div>
    );
  if (value === "ok")
    return (
      <div role="status" className="notice">
        Action enregistrée.
      </div>
    );
  return null;
}
export function Money({ cents }: { cents: number | string }) {
  return (
    <>
      {new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(Number(cents) / 100)}
    </>
  );
}
export function DateText({ value }: { value: string }) {
  return (
    <>
      {new Intl.DateTimeFormat("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Paris",
      }).format(new Date(value))}
    </>
  );
}
export type Doc = {
  id: string;
  file_name: string;
  kind: string;
  verified_at: string | null;
  expires_at: string | null;
  opportunity_id: string | null;
  contractor_id: string | null;
  supersedes: string | null;
  bound_revision: number | null;
  revoked_at: string | null;
  scan_status: string;
};
export function Documents({
  documents,
  owner,
  ai = false,
}: {
  documents: Doc[];
  owner: boolean;
  ai?: boolean;
}) {
  if (!documents.length) return <p className="empty">Aucun document.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Document</th>
            <th>Échéance</th>
            <th>Vérification</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((d) => {
            const state = d.revoked_at
              ? "RÉVOQUÉ"
              : d.expires_at && Date.parse(d.expires_at) < Date.now()
                ? "EXPIRÉ"
                : d.verified_at
                  ? "VÉRIFIÉ"
                  : "À VÉRIFIER";
            return (
              <tr key={d.id}>
                <td>
                  <Link href={`/api/documents/${d.id}`} prefetch={false}>
                    {d.file_name}
                  </Link>
                  <br />
                  <span className="muted">
                    {d.kind}
                    {d.bound_revision ? ` · Révision ${d.bound_revision}` : ""}
                  </span>
                  {d.supersedes && (
                    <div className="small muted">
                      Remplace un document antérieur
                    </div>
                  )}
                </td>
                <td>
                  {d.expires_at ? (
                    <DateText value={d.expires_at} />
                  ) : (
                    "Sans échéance"
                  )}
                </td>
                <td>
                  <span
                    className={`badge ${state === "VÉRIFIÉ" ? "good" : "warn"}`}
                  >
                    {state}
                  </span>
                  <p className="small muted">Scan : {d.scan_status}</p>
                </td>
                <td>
                  {owner && !d.revoked_at && (
                    <>
                      {d.scan_status === "PENDING" && (
                        <form action={scanDocument}>
                          <input
                            name="document_id"
                            type="hidden"
                            value={d.id}
                          />
                          <button className="secondary">
                            Analyser avec l’antivirus
                          </button>
                        </form>
                      )}
                      {!d.verified_at && (
                        <form action={verifyDocument}>
                          <input
                            name="document_id"
                            type="hidden"
                            value={d.id}
                          />
                          <button className="secondary">
                            Vérifier après inspection
                          </button>
                        </form>
                      )}
                      <details>
                        <summary>Révoquer le document</summary>
                        <form action={revokeDocument} className="stack">
                          <input
                            name="document_id"
                            type="hidden"
                            value={d.id}
                          />
                          <Field
                            label="Motif de révocation"
                            name="reason"
                            required
                            maxLength={4000}
                          />
                          <button className="danger">Révoquer</button>
                        </form>
                      </details>
                    </>
                  )}
                  {ai &&
                    !d.revoked_at &&
                    ["SOLICITATION", "AMENDMENT"].includes(d.kind) && (
                      <details>
                        <summary>Extraire avec l’IA</summary>
                        <form action={extractRequirements} className="stack">
                          <input
                            name="document_id"
                            type="hidden"
                            value={d.id}
                          />
                          <label>
                            <input name="ai_consent" type="checkbox" required />{" "}
                            Je confirme que ce PDF est public, sans données
                            sensibles, et j’autorise son traitement par OpenAI.
                          </label>
                          <p className="small muted">
                            PDF texte uniquement, ≤100 pages et ≤80 000
                            caractères. Chaque résultat reste non vérifié. L’OCR
                            des scans exige un processus séparé.
                          </p>
                          <button>Créer la matrice brouillon</button>
                        </form>
                      </details>
                    )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
export function Upload({
  opportunityId,
  contractorId,
  context = "workspace",
  existing = [],
}: {
  opportunityId?: string;
  contractorId?: string;
  context?: "workspace" | "portal";
  existing?: Doc[];
}) {
  const types = contractorId
    ? ["W9", "INSURANCE", "LICENSE", "CAPABILITY", "QUOTE", "OTHER"]
    : ["SOLICITATION", "AMENDMENT", "FINAL_PACKAGE", "OTHER"];
  return (
    <details>
      <summary>Ajouter un document privé</summary>
      <form action={uploadDocument} className="form-grid">
        <input name="context" type="hidden" value={context} />
        <input
          name="opportunity_id"
          type="hidden"
          value={opportunityId || ""}
        />
        <input name="contractor_id" type="hidden" value={contractorId || ""} />
        <Choice label="Type" name="kind" required>
          {types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Choice>
        <Field
          label="Expiration éventuelle · UTC"
          name="expires_at"
          type="datetime-local"
        />
        {!!opportunityId && (
          <Choice label="Document remplacé par l’amendement" name="supersedes">
            <option value="">Aucun</option>
            {existing
              .filter((d) => ["SOLICITATION", "AMENDMENT"].includes(d.kind))
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.file_name}
                </option>
              ))}
          </Choice>
        )}
        <Field
          label="PDF, PNG ou JPEG · 10 Mo maximum"
          name="file"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          required
        />
        <p className="small muted wide">
          Les fichiers sont conservés dans un bucket privé et téléchargés en
          pièce jointe. Un package final doit être un PDF complet, préparé et
          inspecté par un humain après le dernier chiffrage.
        </p>
        <button className="wide">Importer</button>
      </form>
    </details>
  );
}
