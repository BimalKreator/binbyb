"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import api, { setStoredToken } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { Loader } from "@/components/Loader";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast.error("Email and password are required.");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post<{
        success: boolean;
        token?: string;
        user?: { email: string; role: string };
        message?: string;
      }>("/auth/login", { email: email.trim(), password });
      if (data.success && data.token) {
        setStoredToken(data.token);
        useAuthStore.getState().setAuth(data.token, data.user ?? null);
        toast.success("Login successful.");
        router.replace("/");
      } else {
        toast.error(data.message ?? "Login failed.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center px-4 safe-area-inset">
      <div className="w-full max-w-[22rem]">
        <h1 className="text-xl font-semibold text-foreground text-center mb-6">BINBYB</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-slate-400">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              className="h-11 rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              autoComplete="email"
              disabled={loading}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-slate-400">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="h-11 rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              autoComplete="current-password"
              disabled={loading}
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="h-11 rounded-lg font-medium text-white transition-colors disabled:opacity-60"
            style={{ backgroundColor: "var(--primary)" }}
          >
            {loading ? <Loader size="small" className="mx-auto py-2" /> : "Log in"}
          </button>
        </form>
        <p className="text-center text-slate-500 text-sm mt-4">
          <Link href="/" className="underline hover:text-slate-400">Back to app</Link>
        </p>
      </div>
    </div>
  );
}
