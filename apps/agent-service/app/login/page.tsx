import { Suspense } from "react";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

const TEAM = [
  {
    name: "Sarah Chen",
    role: "Broker · Harbor Realty",
    src: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=176&h=176&fit=crop&crop=face",
  },
  {
    name: "Marcus Webb",
    role: "ISA · Summit Homes",
    src: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=176&h=176&fit=crop&crop=face",
  },
  {
    name: "Elena Ruiz",
    role: "Team Lead · Coastal Group",
    src: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=176&h=176&fit=crop&crop=face",
  },
];

function PromoPanel() {
  return (
    <aside className={styles.right} aria-label="Product overview">
      <div className={styles.decor} aria-hidden>
        <span className={styles.sparkle}>✦</span>
        <span className={styles.sparkle}>★</span>
        <span className={styles.sparkle}>✧</span>
      </div>

      <div className={styles.rightInner}>
        <p className={styles.eyebrow}>REOS 2.0 · AI-powered lead engagement</p>
        <h2 className={styles.headline}>
          Be in the room when
          <br />
          your best leads are
          <br />
          ready to move
        </h2>
        <p className={styles.body}>
          Concierge, scheduling, and follow-up agents work your pipeline over SMS,
          while your team focuses on closing. Every conversation lands in one
          simple inbox.
        </p>
        <span className={styles.promoBtn}>
          Learn more
          <span aria-hidden>↗</span>
        </span>
      </div>

      <div className={styles.avatars}>
        {TEAM.map((person) => (
          <div key={person.name} className={styles.avatarBlock}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.avatar}
              src={person.src}
              alt=""
              width={88}
              height={88}
            />
            <p className={styles.avatarName}>{person.name}</p>
            <p className={styles.avatarRole}>{person.role}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default function LoginPage() {
  return (
    <div className={styles.shell}>
      <Suspense fallback={<div className={styles.left}>Loading…</div>}>
        <LoginForm />
      </Suspense>
      <PromoPanel />
    </div>
  );
}
