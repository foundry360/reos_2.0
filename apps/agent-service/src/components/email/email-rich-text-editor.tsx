"use client";

import { useEffect, useRef } from "react";
import styles from "@/components/email/email.module.css";

interface EmailRichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
}

function exec(command: string, value?: string) {
  document.execCommand(command, false, value);
}

export function EmailRichTextEditor({ value, onChange }: EmailRichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (node.innerHTML !== value) {
      node.innerHTML = value || "<p><br></p>";
    }
  }, [value]);

  return (
    <div className={styles.richEditor}>
      <div className={styles.richToolbar} role="toolbar" aria-label="Formatting">
        <button type="button" className={styles.richBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("bold"); onChange(ref.current?.innerHTML ?? ""); }} aria-label="Bold">
          B
        </button>
        <button type="button" className={styles.richBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("italic"); onChange(ref.current?.innerHTML ?? ""); }} aria-label="Italic">
          I
        </button>
        <button type="button" className={styles.richBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("underline"); onChange(ref.current?.innerHTML ?? ""); }} aria-label="Underline">
          U
        </button>
        <button type="button" className={styles.richBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("insertUnorderedList"); onChange(ref.current?.innerHTML ?? ""); }} aria-label="Bulleted list">
          •
        </button>
        <button type="button" className={styles.richBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => { exec("insertOrderedList"); onChange(ref.current?.innerHTML ?? ""); }} aria-label="Numbered list">
          1.
        </button>
        <button
          type="button"
          className={styles.richBtn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt("Link URL");
            if (url) exec("createLink", url);
            onChange(ref.current?.innerHTML ?? "");
          }}
          aria-label="Insert link"
        >
          Link
        </button>
      </div>
      <div
        ref={ref}
        className={styles.richBody}
        contentEditable
        suppressContentEditableWarning
        onInput={() => onChange(ref.current?.innerHTML ?? "")}
        aria-label="Email body"
      />
    </div>
  );
}
