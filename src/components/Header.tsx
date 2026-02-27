"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu, Settings } from "lucide-react";

const NAV_LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/screener", label: "Screener" },
  { href: "/funds", label: "Funds" },
  { href: "/trades", label: "Trades" },
  { href: "/settings", label: "Settings" },
];

export function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    if (isMenuOpen) {
      document.addEventListener("click", handleClickOutside);
    }
    return () => document.removeEventListener("click", handleClickOutside);
  }, [isMenuOpen]);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 safe-area-inset bg-[var(--background)] border-b border-slate-700/50">
      <div className="flex items-center justify-between h-16 px-4 max-w-[100vw] md:max-w-4xl md:mx-auto relative" ref={menuRef}>
        {/* Hamburger menu left */}
        <button
          type="button"
          onClick={() => setIsMenuOpen((o) => !o)}
          className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full text-slate-300 hover:text-foreground hover:bg-slate-700/50 active:scale-95 transition-colors md:w-11 md:h-11"
          aria-label="Open menu"
          aria-expanded={isMenuOpen}
        >
          <Menu className="w-6 h-6" />
        </button>

        {/* Logo center */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center h-12">
          <Image
            src="/logo.png"
            alt="BINBYB"
            width={180}
            height={48}
            className="h-12 w-auto object-contain"
          />
        </div>

        {/* Settings right */}
        <Link
          href="/settings"
          className="w-11 h-11 flex items-center justify-center rounded-full text-slate-400 hover:text-foreground hover:bg-slate-700/50 active:scale-95 transition-colors md:w-12 md:h-12"
          aria-label="Settings"
        >
          <Settings className="w-5 h-5 md:w-6 md:h-6" />
        </Link>
      </div>

      {/* Dropdown navigation */}
      {isMenuOpen && (
        <div className="absolute top-16 left-4 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 w-48 py-1">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setIsMenuOpen(false)}
              className="block px-4 py-2.5 text-slate-300 hover:bg-slate-700/50 hover:text-foreground transition-colors"
            >
              {label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}
