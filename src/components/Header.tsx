"use client";

import Image from "next/image";
import Link from "next/link";
import { Settings } from "lucide-react";

export function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 safe-area-inset bg-[var(--background)] border-b border-slate-700/50">
      <div className="flex items-center justify-between h-14 px-4 max-w-[100vw] md:max-w-4xl md:mx-auto">
        {/* Logo left - placeholder or link */}
        <div
          className="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center md:w-9 md:h-9"
          style={{ backgroundColor: "color-mix(in srgb, var(--primary) 20%, transparent)" }}
        >
          <span className="font-semibold text-sm" style={{ color: "var(--primary)" }}>
            B
          </span>
        </div>

        {/* Logo center */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center h-8">
          <Image
            src="/logo.png"
            alt="BINBYB"
            width={120}
            height={32}
            className="h-8 w-auto object-contain"
          />
        </div>

        {/* Settings right */}
        <Link
          href="/settings"
          className="w-10 h-10 flex items-center justify-center rounded-full text-slate-400 hover:text-foreground hover:bg-slate-700/50 active:scale-95 transition-colors md:w-11 md:h-11"
          aria-label="Settings"
        >
          <Settings className="w-5 h-5 md:w-6 md:h-6" />
        </Link>
      </div>
    </header>
  );
}
