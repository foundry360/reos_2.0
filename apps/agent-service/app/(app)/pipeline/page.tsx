import styles from "@/components/shell/shell.module.css";

export default function PipelinePage() {
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Pipeline</h1>
          <p className={styles.pageSubtitle}>Track leads by status</p>
        </div>
      </div>
      <div className={styles.card}>
        <p className={styles.empty}>Pipeline UI coming soon.</p>
      </div>
    </>
  );
}
