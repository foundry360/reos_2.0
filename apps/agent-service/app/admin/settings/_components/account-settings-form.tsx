"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  removeAvatarAction,
  updateDisplayNameAction,
  uploadAvatarAction,
} from "@/lib/profile/actions";
import { UserAvatar } from "@/components/shell/user-avatar";
import styles from "@/components/shell/shell.module.css";

interface AccountSettingsFormProps {
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export function AccountSettingsForm({
  email,
  displayName,
  avatarUrl,
}: AccountSettingsFormProps) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(displayName);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState(false);
  const [photoPending, startPhotoTransition] = useTransition();
  const [namePending, startNameTransition] = useTransition();

  useEffect(() => {
    setName(displayName);
  }, [displayName]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPhotoError(null);
    const formData = new FormData();
    formData.set("avatar", file);

    startPhotoTransition(async () => {
      const result = await uploadAvatarAction(formData);
      if (!result.ok) {
        setPhotoError(result.error ?? "Upload failed.");
        return;
      }
      router.refresh();
    });

    e.target.value = "";
  }

  function handleRemovePhoto() {
    setPhotoError(null);
    startPhotoTransition(async () => {
      const result = await removeAvatarAction();
      if (!result.ok) {
        setPhotoError(result.error ?? "Could not remove photo.");
        return;
      }
      router.refresh();
    });
  }

  function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameSuccess(false);

    const formData = new FormData();
    formData.set("displayName", name);

    startNameTransition(async () => {
      const result = await updateDisplayNameAction(formData);
      if (!result.ok) {
        setNameError(result.error ?? "Could not save name.");
        return;
      }
      setNameSuccess(true);
      router.refresh();
    });
  }

  return (
    <div className={styles.settingsStack}>
      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Profile photo</h2>
        <p className={styles.settingsSectionDesc}>
          JPEG, PNG, WebP, or GIF. Max 5 MB.
        </p>

        {photoError && <p className={styles.error}>{photoError}</p>}

        <div className={styles.settingsPhotoRow}>
          <UserAvatar
            email={email}
            displayName={displayName}
            avatarUrl={avatarUrl}
            className={styles.settingsAvatar}
          />
          <div className={styles.settingsPhotoActions}>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              onChange={handleFileChange}
            />
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={photoPending}
              onClick={() => fileRef.current?.click()}
            >
              {photoPending ? "Uploading…" : "Upload Photo"}
            </button>
            {avatarUrl && (
              <button
                type="button"
                className={styles.btnSecondary}
                disabled={photoPending}
                onClick={handleRemovePhoto}
              >
                Remove Photo
              </button>
            )}
          </div>
        </div>
      </section>

      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Display name</h2>
        <p className={styles.settingsSectionDesc}>
          Shown in the header and account menu.
        </p>

        <form className={styles.settingsForm} onSubmit={handleNameSubmit}>
          {nameError && <p className={styles.error}>{nameError}</p>}
          {nameSuccess && (
            <p className={styles.success}>Display name saved.</p>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="displayName">
              Name
            </label>
            <input
              id="displayName"
              className={styles.input}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameSuccess(false);
              }}
              maxLength={80}
              required
              disabled={namePending}
            />
          </div>

          <button type="submit" className={styles.btnPrimary} disabled={namePending}>
            {namePending ? "Saving…" : "Save Name"}
          </button>
        </form>
      </section>

      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Email</h2>
        <p className={styles.settingsSectionDesc}>
          Sign-in email for this account. Contact support to change it.
        </p>
        <p className={styles.settingsReadOnly}>{email}</p>
      </section>
    </div>
  );
}
