"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KeyRound, LayoutDashboard, LineChart, Receipt, Settings, Terminal, Wallet } from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/screener", label: "Screener", icon: LineChart },
  { href: "/exchange", label: "Exchange", icon: KeyRound },
  { href: "/funds", label: "Funds", icon: Wallet },
  { href: "/trades", label: "Trades", icon: Receipt },
  { href: "/logs", label: "Logs", icon: Terminal },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 safe-area-inset bg-[var(--background)] border-t border-slate-700/50 md:hidden"
      aria-label="Bottom navigation"
    >
      <div className="flex items-center justify-around h-16 max-w-[100vw]">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || (href !== "/" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className="flex flex-col items-center justify-center gap-0.5 min-w-[4rem] py-2 text-slate-400 hover:text-foreground active:scale-95 transition-colors"
              aria-current={isActive ? "page" : undefined}
              aria-label={label}
            >
              <Icon
                className="w-6 h-6"
                style={isActive ? { color: "var(--primary)" } : undefined}
                strokeWidth={isActive ? 2.5 : 2}
              />
              <span
                className={`text-[10px] ${isActive ? "font-medium" : ""}`}
                style={isActive ? { color: "var(--primary)" } : undefined}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
