"use client";

import { usePathname } from "next/navigation";
import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { AuthGuard } from "@/components/AuthGuard";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  if (isLogin) {
    return <AuthGuard>{children}</AuthGuard>;
  }

  return (
    <AuthGuard>
      <Header />
      {/* Exact-height spacer so title sits naturally below header (no excessive gap). */}
      <div className="h-20 shrink-0" aria-hidden="true" />
      <main className="safe-area-inset pb-[calc(env(safe-area-inset-bottom)+4.5rem)] min-h-[100dvh] md:pb-6">
        {children}
      </main>
      <BottomNav />
    </AuthGuard>
  );
}
