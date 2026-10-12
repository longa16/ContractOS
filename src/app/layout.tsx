import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
export const metadata: Metadata = {
  title: "ContractOS — Command Center",
  description: "Government contracting, verified data and human decisions.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-icon">C</span>Contract<span>OS</span>
          </Link>
          <nav>
            <Link href="/workspace">Command Center</Link>
            <Link href="/portal">Portail prestataire</Link>
          </nav>
          <span className="environment">MVP · validation humaine</span>
        </header>
        {children}
        <footer>ContractOS · Les preuves précèdent les décisions.</footer>
      </body>
    </html>
  );
}
