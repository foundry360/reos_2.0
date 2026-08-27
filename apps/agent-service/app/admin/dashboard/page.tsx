import styles from "@/components/shell/shell.module.css";

export default function AdminDashboardPage() {
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Dashboard</h1>
          <p className={styles.pageSubtitle}>Platform overview and key metrics.</p>
        </div>
      </div>

      <div className={styles.card}>
        <p className={styles.empty}>Dashboard coming soon.</p>
      </div>
    </>
  );
}
