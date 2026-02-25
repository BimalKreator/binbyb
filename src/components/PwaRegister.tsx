"use client";

import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (reg.installing) console.log("[PWA] Service worker installing");
        else if (reg.waiting) console.log("[PWA] Service worker waiting");
        else if (reg.active) console.log("[PWA] Service worker active");
      })
      .catch((e) => console.warn("[PWA] Service worker registration failed", e));
  }, []);
  return null;
}
