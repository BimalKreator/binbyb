"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/store/authStore";

const PUBLIC_PATHS = ["/login"];

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, isHydrated, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isHydrated) return;
    const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "?"));
    if (!token && !isPublic) {
      router.replace("/login");
    }
  }, [isHydrated, token, pathname, router]);

  if (!isHydrated && !PUBLIC_PATHS.includes(pathname ?? "")) {
    return (
      <div className="flex items-center justify-center min-h-[40dvh]">
        <div className="w-8 h-8 rounded-full border-2 border-slate-600 border-t-[var(--primary)] animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
