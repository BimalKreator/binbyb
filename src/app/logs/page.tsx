"use client";

import { useState, useEffect, useRef } from "react";
import api from "@/lib/api";
import { Terminal } from "lucide-react";

type LogEntry = {
  level: string;
  message: string;
  category: string | null;
  ts: number;
};

const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<"all" | "entry" | "exit" | "error">("all");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ success: boolean; data: LogEntry[] }>("/logs")
      .then(({ data }) => {
        if (data.success && Array.isArray(data.data)) setLogs(data.data);
      })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));

    const { io } = require("socket.io-client");
    const socket = io(apiOrigin.replace(/\/$/, ""), { path: "/socket.io", transports: ["websocket", "polling"] });
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("system-log", (payload: LogEntry) => {
      setLogs((prev) => [
        ...prev,
        {
          level: payload.level,
          message: payload.message,
          category: payload.category ?? null,
          ts: payload.ts ?? Date.now(),
        },
      ]);
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  const filtered = logs.filter((l) => {
    if (filter === "all") return true;
    if (filter === "error") return l.level === "error" || (l.category && l.category.toLowerCase() === "error");
    if (filter === "entry") return l.category && l.category.toLowerCase() === "entry";
    if (filter === "exit") return l.category && l.category.toLowerCase() === "exit";
    return true;
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filtered.length]);

  return (
    <div className="min-h-[50dvh] w-full px-4 py-4 flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Terminal className="w-5 h-5" />
          System Logs
        </h2>
        <span
          className={
            connected ? "text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400" : "text-xs px-2 py-0.5 rounded bg-slate-600/50 text-slate-400"
          }
        >
          {connected ? "Live" : "Disconnected"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {(["all", "entry", "exit", "error"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              filter === f
                ? "text-xs px-3 py-1.5 rounded-lg border bg-[var(--primary)]/20 border-[var(--primary)] text-[var(--primary)]"
                : "text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300"
            }
          >
            {f === "all" ? "All" : f === "entry" ? "Entry" : f === "exit" ? "Exit" : "Errors"}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-[200px] rounded-lg bg-slate-900 border border-slate-700 overflow-hidden flex flex-col">
        <pre className="flex-1 overflow-auto p-3 font-mono text-xs text-slate-300 whitespace-pre-wrap break-words max-h-[50vh]">
          {loading ? (
            <span className="text-slate-500">Loading logs…</span>
          ) : filtered.length === 0 ? (
            <span className="text-slate-500">No logs to show.</span>
          ) : (
            filtered.map((l, i) => {
              const isError = l.level === "error" || l.category === "error";
              const isEntry = l.category === "entry";
              const isExit = l.category === "exit";
              const lineClass = isError ? "text-red-400" : isEntry ? "text-emerald-400" : isExit ? "text-amber-400" : "text-slate-300";
              return (
                <div key={`${l.ts}-${i}`} className={lineClass}>
                  {new Date(l.ts).toISOString()} [{l.level}] {l.message}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </pre>
      </div>
    </div>
  );
}
