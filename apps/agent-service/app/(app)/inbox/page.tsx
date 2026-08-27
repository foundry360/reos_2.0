import styles from "@/components/shell/shell.module.css";

export default function InboxPage() {
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Inbox</h1>
          <p className={styles.pageSubtitle}>SMS conversations with your leads</p>
        </div>
      </div>
      <div className={styles.card}>
        <p className={styles.empty}>Inbox UI coming soon.</p>
      </div>
    </>
  );
}
