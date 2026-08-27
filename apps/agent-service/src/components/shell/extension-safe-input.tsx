"use client";

import { useEffect, useState, type InputHTMLAttributes } from "react";

/**
 * Defers interactive input rendering until after mount so password managers
 * (e.g. LastPass) cannot inject DOM nodes before hydration.
 */
export function ExtensionSafeInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <input
        {...props}
        readOnly
        tabIndex={-1}
        aria-hidden
        suppressHydrationWarning
      />
    );
  }

  return (
    <input
      {...props}
      autoComplete={props.autoComplete ?? "off"}
      data-lpignore="true"
      data-1p-ignore
    />
  );
}
