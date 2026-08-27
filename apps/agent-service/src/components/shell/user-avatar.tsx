"use client";

import { useState } from "react";
import { resolveProfileAvatarUrl, userInitials } from "@/lib/user-display";
import styles from "./shell.module.css";

interface UserAvatarProps {
  email: string;
  avatarUrl?: string | null;
  className?: string;
}

export function UserAvatar({ email, avatarUrl, className }: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedAvatarUrl = resolveProfileAvatarUrl(avatarUrl);

  if (resolvedAvatarUrl && !imageFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolvedAvatarUrl}
        alt=""
        className={`${styles.avatarImg} ${className ?? ""}`}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span className={`${styles.avatar} ${className ?? ""}`}>{userInitials(email)}</span>
  );
}
