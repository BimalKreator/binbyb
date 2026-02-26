"use client";

import { useState, useEffect, useRef, useMemo } from "react";
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
  groupId?: string | null;
  requestedEntryPrice?: number | null;
  executedEntryPrice?: number | null;
  fee?: number;
};

type LogEntry = {
  level: string;
  message: string;
  category: string | null;
  ts: number;
};

const LIMIT = 20;
// Use HTTPS origin for production; WSS is used automatically over HTTPS
function getSocketOrigin(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") {
    if (window.location.hostname === "tradeictearner.online") return "https://tradeictearner.online";
    return window.location.origin;
  }
  return "http://localhost:5000";
}
const apiOrigin = getSocketOrigin();

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

  /** Group trades by groupId; legacy/single-leg trades become a group of one. */
  const tradeGroups = useMemo(() => {
    const map = new Map<string, TradeRecord[]>();
    for (const t of trades) {
      const key = t.groupId ?? `${t.symbol}-${t.exitTime}-${t._id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.values());
  }, [trades]);

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
    const msg = (l.message ?? "").toLowerCase();
    const level = (l.level ?? "").toLowerCase();
    const category = (l.category ?? "").toLowerCase();
    if (logFilter === "error") {
      if (level === "error" || category === "error") return true;
      return /error|fail|reject|timeout/.test(msg);
    }
    if (logFilter === "entry") {
      if (category === "entry") return true;
      return /entry|new|executing trade|buy|sell/.test(msg);
    }
    if (logFilter === "exit") {
      if (category === "exit") return true;
      return /exit|tp|sl|close|filled/.test(msg);
    }
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
                  const msg = (l.message ?? "").toLowerCase();
                  const isError =
                    l.level === "error" ||
                    (l.category ?? "").toLowerCase() === "error" ||
                    /error|fail|reject|timeout/.test(msg);
                  const isEntry =
                    (l.category ?? "").toLowerCase() === "entry" || /entry|new|executing trade|buy|sell/.test(msg);
                  const isExit =
                    (l.category ?? "").toLowerCase() === "exit" || /exit|tp|sl|close|filled/.test(msg);
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
      <p className="text-sm text-slate-400 mb-4">Arbitrage legs grouped by trade. Combined PnL and fees per group.</p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader />
        </div>
      ) : tradeGroups.length === 0 ? (
        <p className="text-sm text-slate-500 py-6">No trades yet.</p>
      ) : (
        <>
          <div className="space-y-4">
            {tradeGroups.map((group) => {
              const first = group[0];
              const symbol = first?.symbol ?? "";
              const reason = first?.reason ?? "Manual";
              const exitTime = first?.exitTime ? new Date(first.exitTime).toLocaleString() : "";
              const combinedPnl = group.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
              const totalFees = group.reduce((s, t) => s + (Number(t.fee) ?? 0), 0);
              const isLegacySingle = group.length === 1 && (first?.exchange === "binance+bybit" || !first?.groupId);
              const displayLegs: Array<{ exchange: string; t: TradeRecord }> = isLegacySingle
                ? [
                    {
                      exchange: "Binance",
                      t: {
                        ...first!,
                        pnl: (Number(first?.pnl) || 0) / 2,
                        fee: (Number(first?.fee) ?? 0) / 2,
                      },
                    },
                    {
                      exchange: "Bybit",
                      t: {
                        ...first!,
                        pnl: (Number(first?.pnl) || 0) / 2,
                        fee: (Number(first?.fee) ?? 0) / 2,
                      },
                    },
                  ]
                : group.map((t) => ({ exchange: t.exchange || "—", t }));

              return (
                <div key={group.map((t) => t._id).join("-")} className="rounded-lg border border-slate-700 bg-slate-800/30 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-700 bg-slate-800/50">
                    <span className="font-medium text-foreground">{symbol}</span>
                    <span className="text-slate-500 text-xs">{exitTime}</span>
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${reasonColor(reason)}`}>{reason}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700/70">
                          <th className="text-left py-1.5 px-3 text-slate-500 font-medium text-xs">Exchange</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Qty</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Req. Entry</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Exec. Entry</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Req. Exit</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Exec. Exit</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Fee</th>
                          <th className="text-right py-1.5 px-3 text-slate-500 font-medium text-xs">Individual PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayLegs.map(({ exchange, t }, idx) => (
                          <tr key={t._id + (isLegacySingle ? exchange : "") + idx} className="border-b border-slate-700/50 last:border-b-0">
                            <td className="py-1.5 px-3 text-foreground">{exchange}</td>
                            <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">—</td>
                            <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">
                              {t.requestedEntryPrice != null ? Number(t.requestedEntryPrice).toFixed(4) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">
                              {t.executedEntryPrice != null ? Number(t.executedEntryPrice).toFixed(4) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">
                              {t.requestedEntryPrice != null ? Number(t.requestedEntryPrice).toFixed(4) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">
                              {t.exitPrice != null ? Number(t.exitPrice).toFixed(4) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right text-slate-400 tabular-nums">
                              {t.fee != null && t.fee !== 0 ? Number(t.fee).toFixed(4) : "—"}
                            </td>
                            <td className={`py-1.5 px-3 text-right font-medium tabular-nums ${t.pnl != null && t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {t.pnl != null ? (t.pnl >= 0 ? `+${Number(t.pnl).toFixed(2)}` : Number(t.pnl).toFixed(2)) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end gap-6 px-3 py-2 border-t border-slate-700 bg-slate-800/50 text-sm">
                    <span>
                      <span className="text-slate-500">Combined PnL: </span>
                      <span className={combinedPnl >= 0 ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>
                        {combinedPnl >= 0 ? `+${combinedPnl.toFixed(2)}` : combinedPnl.toFixed(2)}
                      </span>
                    </span>
                    <span>
                      <span className="text-slate-500">Total Fees: </span>
                      <span className="text-slate-300 font-medium">{totalFees.toFixed(4)}</span>
                    </span>
                  </div>
                </div>
              );
            })}
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
