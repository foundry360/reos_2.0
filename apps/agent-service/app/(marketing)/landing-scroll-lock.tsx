"use client";

import { useEffect } from "react";

/** Hides the document scrollbar while the marketing landing page is mounted. */
export function LandingScrollLock() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.add("landing-scroll-hidden");
    body.classList.add("landing-scroll-hidden");
    return () => {
      root.classList.remove("landing-scroll-hidden");
      body.classList.remove("landing-scroll-hidden");
    };
  }, []);

  return null;
}
