import type { ReactNode } from "react";
import Link from "next/link";
import styles from "../legal.module.css";

export function LegalPageShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/realtoros-logo-light.png" alt="RealtorOS" className={styles.logo} />
        </Link>
      </header>
      <main className={styles.main}>
        <article className={styles.article}>
          <h1 className={styles.title}>{title}</h1>
          {children}
        </article>
      </main>
      <footer className={styles.footer}>
        <span>© {new Date().getFullYear()} Referral Partners, LLC</span>
        <span className={styles.footerLinks}>
          <Link href="/privacy" target="_blank" rel="noopener noreferrer">
            Privacy
          </Link>
          <Link href="/terms" target="_blank" rel="noopener noreferrer">
            Terms of Service
          </Link>
        </span>
      </footer>
    </div>
  );
}

export function LegalMeta({
  effectiveDate,
  lastUpdated,
}: {
  effectiveDate: string;
  lastUpdated: string;
}) {
  return (
    <p className={styles.meta}>
      <strong>Effective Date:</strong> {effectiveDate}
      <br />
      <strong>Last Updated:</strong> {lastUpdated}
    </p>
  );
}
