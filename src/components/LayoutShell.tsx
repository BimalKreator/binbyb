"use client";

import { usePathname } from "next/navigation";
import { Header } from "@/components/Header";
import { BottomNav } from "@/components/BottomNav";
import { AuthGuard } from "@/components/AuthGuard";
import { PwaRegister } from "@/components/PwaRegister";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  if (isLogin) {
    return <AuthGuard><PwaRegister />{children}</AuthGuard>;
  }

  return (
    <AuthGuard>
      <PwaRegister />
      <div className="flex flex-col min-h-[100dvh]">
        <Header />
        {/* Spacer matching header height (h-16) so content sits below fixed navbar. */}
        <div className="h-16 shrink-0" aria-hidden="true" />
        <main className="flex flex-col flex-1 min-h-0 safe-area-inset min-w-0 overflow-x-hidden">
          {children}
          <div className="h-28 md:h-8 w-full shrink-0" aria-hidden="true" />
        </main>
        <BottomNav />
      </div>
    </AuthGuard>
  );
}
