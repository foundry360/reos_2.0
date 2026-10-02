"use client";

import { useEffect, useRef, useState } from "react";
import {
  JOURNEY_NODE_PICKER_ORDER,
  journeyNodeTypeDefinition,
} from "@/lib/journeys/journey-node-types";
import type { JourneyNodeType } from "@/lib/journeys/journey-types";
import { IconPlus } from "@/components/shell/sidebar-nav";
import { JourneyNodeIcon } from "../journey-node-icon";
import shell from "@/components/shell/shell.module.css";
import styles from "../journeys.module.css";

export function NodePicker({ onPick }: { onPick: (type: JourneyNodeType) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.pickerWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${shell.btnPrimary} ${shell.btnPill}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconPlus />
        Add Node
      </button>
      {open ? (
        <div className={styles.picker} role="menu" aria-label="Node types">
          {JOURNEY_NODE_PICKER_ORDER.map((type) => {
            const definition = journeyNodeTypeDefinition(type);
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                className={styles.pickerItem}
                onClick={() => {
                  onPick(type);
                  setOpen(false);
                }}
              >
                <JourneyNodeIcon type={type} />
                <span className={styles.pickerItemText}>
                  <span className={styles.pickerItemLabel}>{definition.label}</span>
                  <span className={styles.pickerItemDesc}>{definition.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
