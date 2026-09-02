"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  EmailComposeContext,
  EmailComposeDraft,
} from "@/lib/email/email-types";
import { contactPrefillRecipient } from "@/lib/email/email-utils";

const EMPTY_DRAFT: EmailComposeDraft = {
  to: "",
  cc: "",
  subject: "",
  bodyHtml: "",
};

interface EmailComposeState {
  open: boolean;
  minimized: boolean;
  draft: EmailComposeDraft;
  context: EmailComposeContext;
  dirty: boolean;
  needsSignature: boolean;
}

interface EmailComposeApi {
  open: boolean;
  minimized: boolean;
  draft: EmailComposeDraft;
  context: EmailComposeContext;
  dirty: boolean;
  needsSignature: boolean;
  openCompose: (context?: EmailComposeContext, draft?: Partial<EmailComposeDraft>) => void;
  closeCompose: () => void;
  minimizeCompose: () => void;
  restoreCompose: () => void;
  setDraft: (
    patch: Partial<EmailComposeDraft>,
    options?: { markDirty?: boolean },
  ) => void;
  setContext: (patch: Partial<EmailComposeContext>) => void;
  markSignatureApplied: () => void;
  resetDraft: () => void;
}

const EmailComposeContextReact = createContext<EmailComposeApi | null>(null);

function draftFromContext(
  context: EmailComposeContext,
  partial?: Partial<EmailComposeDraft>,
): EmailComposeDraft {
  const to =
    partial?.to ??
    (context.contactEmail
      ? contactPrefillRecipient(context.contactName ?? "", context.contactEmail)
      : "");
  return {
    to,
    cc: partial?.cc ?? "",
    subject: partial?.subject ?? "",
    bodyHtml: partial?.bodyHtml ?? "",
  };
}

export function EmailComposeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EmailComposeState>({
    open: false,
    minimized: false,
    draft: EMPTY_DRAFT,
    context: {},
    dirty: false,
    needsSignature: false,
  });

  const openCompose = useCallback(
    (context: EmailComposeContext = {}, draft?: Partial<EmailComposeDraft>) => {
      const nextDraft = draftFromContext(context, draft);
      setState({
        open: true,
        minimized: false,
        context,
        draft: nextDraft,
        dirty: false,
        needsSignature: !nextDraft.bodyHtml.trim(),
      });
    },
    [],
  );

  const closeCompose = useCallback(() => {
    setState((current) => {
      if (current.dirty && current.open) {
        const discard = window.confirm(
          "Discard this email? Your unsaved changes will be lost.",
        );
        if (!discard) return current;
      }
      return {
        open: false,
        minimized: false,
        draft: EMPTY_DRAFT,
        context: {},
        dirty: false,
        needsSignature: false,
      };
    });
  }, []);

  const minimizeCompose = useCallback(() => {
    setState((current) => ({ ...current, minimized: true }));
  }, []);

  const restoreCompose = useCallback(() => {
    setState((current) => ({ ...current, minimized: false, open: true }));
  }, []);

  const setDraft = useCallback(
    (patch: Partial<EmailComposeDraft>, options?: { markDirty?: boolean }) => {
      setState((current) => ({
        ...current,
        draft: { ...current.draft, ...patch },
        dirty: options?.markDirty === false ? current.dirty : true,
      }));
    },
    [],
  );

  const setContext = useCallback((patch: Partial<EmailComposeContext>) => {
    setState((current) => ({
      ...current,
      context: { ...current.context, ...patch },
    }));
  }, []);

  const markSignatureApplied = useCallback(() => {
    setState((current) => ({ ...current, needsSignature: false }));
  }, []);

  const resetDraft = useCallback(() => {
    setState((current) => ({
      ...current,
      draft: EMPTY_DRAFT,
      dirty: false,
      needsSignature: false,
    }));
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        openCompose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openCompose]);

  const value = useMemo<EmailComposeApi>(
    () => ({
      ...state,
      openCompose,
      closeCompose,
      minimizeCompose,
      restoreCompose,
      setDraft,
      setContext,
      markSignatureApplied,
      resetDraft,
    }),
    [
      state,
      openCompose,
      closeCompose,
      minimizeCompose,
      restoreCompose,
      setDraft,
      setContext,
      markSignatureApplied,
      resetDraft,
    ],
  );

  return (
    <EmailComposeContextReact.Provider value={value}>
      {children}
    </EmailComposeContextReact.Provider>
  );
}

export function useEmailCompose(): EmailComposeApi {
  const ctx = useContext(EmailComposeContextReact);
  if (!ctx) {
    throw new Error("useEmailCompose must be used within EmailComposeProvider");
  }
  return ctx;
}
