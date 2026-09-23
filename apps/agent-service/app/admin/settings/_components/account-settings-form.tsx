"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  removeAvatarAction,
  updateDisplayNameAction,
  updateReplyToEmailAction,
  uploadAvatarAction,
} from "@/lib/profile/actions";
import { UserAvatar } from "@/components/shell/user-avatar";
import styles from "@/components/shell/shell.module.css";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

interface AccountSettingsFormProps {
  email: string;
  displayName: string;
  avatarUrl: string | null;
  replyToEmail: string | null;
}

export function AccountSettingsForm({
  email,
  displayName,
  avatarUrl,
  replyToEmail,
}: AccountSettingsFormProps) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(displayName);
  const [replyTo, setReplyTo] = useState(replyToEmail ?? "");
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySuccess, setReplySuccess] = useState(false);
  const [photoPending, startPhotoTransition] = useTransition();
  const [namePending, startNameTransition] = useTransition();
  const [replyPending, startReplyTransition] = useTransition();

  useEffect(() => {
    setName(displayName);
  }, [displayName]);

  useEffect(() => {
    setReplyTo(replyToEmail ?? "");
  }, [replyToEmail]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPhotoError(null);

    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("Image must be 5 MB or smaller.");
      e.target.value = "";
      return;
    }

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

  function handleReplyToSubmit(e: React.FormEvent) {
    e.preventDefault();
    setReplyError(null);
    setReplySuccess(false);

    const formData = new FormData();
    formData.set("replyToEmail", replyTo);

    startReplyTransition(async () => {
      const result = await updateReplyToEmailAction(formData);
      if (!result.ok) {
        setReplyError(result.error ?? "Could not save reply-to email.");
        return;
      }
      setReplySuccess(true);
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
              accept="image/jpeg,image/jpg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
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

      <section className={styles.settingsSection}>
        <h2 className={styles.settingsSectionTitle}>Email Replies</h2>
        <p className={styles.settingsSectionDesc}>
          When customers reply to emails you send from REOS, messages go here.
          Leave blank to use your sign-in email ({email}).
        </p>

        <form className={styles.settingsForm} onSubmit={handleReplyToSubmit}>
          {replyError && <p className={styles.error}>{replyError}</p>}
          {replySuccess && (
            <p className={styles.success}>Email Replies saved.</p>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="replyToEmail">
              Email
            </label>
            <input
              id="replyToEmail"
              type="email"
              className={styles.input}
              value={replyTo}
              onChange={(e) => {
                setReplyTo(e.target.value);
                setReplySuccess(false);
              }}
              placeholder={email}
              disabled={replyPending}
              autoComplete="email"
            />
          </div>

          <button type="submit" className={styles.btnPrimary} disabled={replyPending}>
            {replyPending ? "Saving…" : "Save"}
          </button>
        </form>
      </section>
    </div>
  );
}
