"use client";

import { useState } from "react";
import { profileInitials, resolveProfileAvatarUrl } from "@/lib/user-display";
import styles from "./shell.module.css";

interface UserAvatarProps {
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  className?: string;
}

export function UserAvatar({ email, displayName, avatarUrl, className }: UserAvatarProps) {
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
    <span className={`${styles.avatar} ${className ?? ""}`}>
      {profileInitials(displayName, email)}
    </span>
  );
}
