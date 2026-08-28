import { ThemeProvider } from "@/components/theme/theme-provider";
import { SetPasswordClient } from "./set-password-form";
import styles from "../login/login.module.css";

export default function SetPasswordPage() {
  return (
    <ThemeProvider preference="light">
      <div className={styles.shell} data-theme="light">
        <SetPasswordClient />
        <aside className={styles.right} aria-hidden>
          <div className={styles.rightInner}>
            <p className={styles.eyebrow}>Welcome to REOS</p>
            <h2 className={styles.headline}>
              One more step
              <br />
              before your workspace
            </h2>
            <p className={styles.body}>
              Set a password so you can sign in securely from any device.
            </p>
          </div>
        </aside>
      </div>
    </ThemeProvider>
  );
}
