"use client";

import { useState, useEffect, useRef } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";
import { ChevronLeft, ChevronRight, Receipt, Terminal } from "lucide-react";

type TradeRecord = {
  _id: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  reason: string;
  pnl: number;
  exitTime: string;
  side: string;
  exchange: string;
};

type LogEntry = {
  level: string;
  message: string;
  category: string | null;
  ts: number;
};

const LIMIT = 20;
const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

function reasonColor(reason: string): string {
  switch (reason) {
    case "Target":
      return "text-emerald-400 bg-emerald-500/15";
    case "SL":
      return "text-red-400 bg-red-500/15";
    case "Orphan":
      return "text-amber-400 bg-amber-500/15";
    case "Manual":
    default:
      return "text-slate-400 bg-slate-500/15";
  }
}

export default function TradesPage() {
  const [tradesTab, setTradesTab] = useState<"history" | "logs">("history");

  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [connected, setConnected] = useState(false);
  const [logFilter, setLogFilter] = useState<"all" | "entry" | "exit" | "error">("all");
  const logsBottomRef = useRef<HTMLDivElement>(null);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  useEffect(() => {
    if (tradesTab !== "history") return;
    setLoading(true);
    api
      .get<{ success: boolean; data: { total: number; page: number; limit: number; trades: TradeRecord[] } }>(
        "/trades/history",
        { params: { page, limit: LIMIT } }
      )
      .then(({ data }) => {
        if (data.success && data.data) {
          setTrades(data.data.trades || []);
          setTotal(data.data.total ?? 0);
        }
      })
      .catch(() => toast.error("Failed to load trade history"))
      .finally(() => setLoading(false));
  }, [tradesTab, page]);

  useEffect(() => {
    if (tradesTab !== "logs") return;
    setLoadingLogs(true);
    api
      .get<{ success: boolean; data: LogEntry[] }>("/logs")
      .then(({ data }) => {
        if (data.success && Array.isArray(data.data)) setLogs(data.data);
      })
      .catch(() => setLogs([]))
      .finally(() => setLoadingLogs(false));

    const { io } = require("socket.io-client");
    const socket = io(apiOrigin.replace(/\/$/, ""), { path: "/socket.io", transports: ["websocket", "polling"] });
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("system-log", (payload: LogEntry) => {
      setLogs((prev) => [
        ...prev,
        { level: payload.level, message: payload.message, category: payload.category ?? null, ts: payload.ts ?? Date.now() },
      ]);
    });
    return () => {
      socket.disconnect();
    };
  }, [tradesTab]);

  const filteredLogs = logs.filter((l) => {
    if (logFilter === "all") return true;
    if (logFilter === "error") return l.level === "error" || (l.category && l.category.toLowerCase() === "error");
    if (logFilter === "entry") return l.category && l.category.toLowerCase() === "entry";
    if (logFilter === "exit") return l.category && l.category.toLowerCase() === "exit";
    return true;
  });

  useEffect(() => {
    logsBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filteredLogs.length]);

  return (
    <div className="min-h-[50dvh] w-full px-4 py-4">
      <div className="flex gap-1 p-1 rounded-lg bg-slate-800/50 border border-slate-700 mb-4">
        <button
          type="button"
          onClick={() => setTradesTab("history")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            tradesTab === "history" ? "bg-[var(--primary)] text-white" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Receipt className="w-4 h-4" />
          Trade History
        </button>
        <button
          type="button"
          onClick={() => setTradesTab("logs")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            tradesTab === "logs" ? "bg-[var(--primary)] text-white" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Terminal className="w-4 h-4" />
          System Logs
        </button>
      </div>

      {tradesTab === "logs" ? (
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              System Logs
            </h2>
            <span className={connected ? "text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400" : "text-xs px-2 py-0.5 rounded bg-slate-600/50 text-slate-400"}>
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {(["all", "entry", "exit", "error"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setLogFilter(f)}
                className={logFilter === f ? "text-xs px-3 py-1.5 rounded-lg border bg-[var(--primary)]/20 border-[var(--primary)] text-[var(--primary)]" : "text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-300"}
              >
                {f === "all" ? "All" : f === "entry" ? "Entry" : f === "exit" ? "Exit" : "Errors"}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-[200px] rounded-lg bg-slate-900 border border-slate-700 overflow-hidden flex flex-col">
            <pre className="flex-1 overflow-auto p-3 font-mono text-xs text-slate-300 whitespace-pre-wrap break-words max-h-[50vh]">
              {loadingLogs ? (
                <span className="text-slate-500">Loading logs…</span>
              ) : filteredLogs.length === 0 ? (
                <span className="text-slate-500">No logs to show.</span>
              ) : (
                filteredLogs.map((l, i) => {
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
              <div ref={logsBottomRef} />
            </pre>
          </div>
        </div>
      ) : (
        <>
      <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-2">
        <Receipt className="w-5 h-5" />
        Trade History
      </h2>
      <p className="text-sm text-slate-400 mb-4">Closed trades with reason and PnL.</p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader />
        </div>
      ) : trades.length === 0 ? (
        <p className="text-sm text-slate-500 py-6">No trades yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/50">
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Symbol</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Entry</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Exit</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Reason</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id} className="border-b border-slate-700/50 hover:bg-slate-800/30">
                    <td className="py-2 px-3 text-foreground">{t.symbol}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{t.entryPrice != null ? Number(t.entryPrice).toFixed(4) : "—"}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{t.exitPrice != null ? Number(t.exitPrice).toFixed(4) : "—"}</td>
                    <td className="py-2 px-3">
                      <span className={`inline-block px-2 py-0.5 rounded ${reasonColor(t.reason || "Manual")}`}>
                        {t.reason || "Manual"}
                      </span>
                    </td>
                    <td className={`py-2 px-3 text-right font-medium ${t.pnl != null && t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {t.pnl != null ? (t.pnl >= 0 ? `+${Number(t.pnl).toFixed(2)}` : Number(t.pnl).toFixed(2)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-slate-400">
              Page {page} of {totalPages} · {total} total
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-800"
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-800"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}
