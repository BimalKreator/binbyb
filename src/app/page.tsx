"use client";

import { useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";
import { XCircle } from "lucide-react";

type VolatilityMeter = { level: string; count?: number };

type MetricsData = {
  binanceBalance: number;
  bybitBalance: number;
  currentBalance: number;
  openingBalance: number;
  totalDeposits: number;
  totalWithdrawals: number;
  profit: number;
  profitPercent: number | null;
  dailyROI: number | null;
  totalCapitalINR: number;
  usdToInr: number;
  volatilityMeter: VolatilityMeter;
};

type PositionLeg = {
  side: string;
  positionSide?: string;
  positionAmt: number;
  unrealizedProfit: number;
  marginUsed: number;
};

type PositionRow = {
  symbol: string;
  binance: PositionLeg;
  bybit: PositionLeg;
  combinedUnrealizedProfit: number;
  combinedMarginUsed: number;
  combinedPnlPercent: number | null;
  nextFundingPayment: { nextFundingTime: number; nextFundingTimeISO: string } | null;
};

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatInr(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
}

function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n >= 0 ? "+" : "";
  return s + n.toFixed(2) + "%";
}

function formatTimeToFunding(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function VolatilityGauge({ level, count = 0 }: VolatilityMeter) {
  const normalized = level === "High" ? 100 : level === "Med" ? 55 : level === "Low" ? 20 : 0;
  const color =
    level === "High"
      ? "var(--loss)"
      : level === "Med"
        ? "#eab308"
        : "var(--profit)";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-full h-3 rounded-full bg-slate-700 overflow-hidden" aria-hidden>
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${normalized}%`, backgroundColor: color }}
        />
      </div>
      <div className="flex items-center justify-between w-full text-xs">
        <span className="text-slate-400">Volatility</span>
        <span className="font-medium" style={{ color }}>
          {level}
          {Number.isFinite(count) && count >= 0 ? ` (${count})` : ""}
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: MetricsData }>("/dashboard/metrics");
      if (res.data?.success && res.data.data) setMetrics(res.data.data);
    } catch {
      toast.error("Failed to load metrics");
    }
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data?: PositionRow[] }>("/dashboard/positions");
      const raw = res.data?.success ? res.data.data : undefined;
      const list = Array.isArray(raw)
        ? raw.filter(
            (p): p is PositionRow =>
              p != null && typeof p.symbol === "string" && p.binance != null && p.bybit != null
          )
        : [];
      setPositions(list);
    } catch {
      toast.error("Failed to load positions");
    }
  }, []);

  const refresh = useCallback(() => {
    fetchMetrics();
    fetchPositions();
  }, [fetchMetrics, fetchPositions]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await Promise.all([fetchMetrics(), fetchPositions()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMetrics, fetchPositions]);

  const handleCloseTrade = async (symbol: string) => {
    setClosingSymbol(symbol);
    try {
      await api.post("/trade/close-all", { symbol });
      toast.success(`Closing ${symbol}`);
      await refresh();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Close failed");
    } finally {
      setClosingSymbol(null);
    }
  };

  if (loading && !metrics) {
    return (
      <div className="w-full max-w-[100vw] overflow-x-hidden flex items-center justify-center min-h-[40dvh]">
        <Loader />
      </div>
    );
  }

  const m = metrics ?? ({} as MetricsData);
  const vol = m.volatilityMeter ?? { level: "Low", count: 0 };

  return (
    <div className="w-full min-w-0 max-w-[100vw] overflow-x-hidden">
      <div className="mx-auto w-full min-w-0 px-4 py-4 sm:px-6 md:px-8 lg:max-w-4xl lg:px-10">
        <h2 className="text-lg font-semibold text-foreground mb-4">Dashboard</h2>

        {/* Top cards: compact grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          {/* Capital */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Capital</p>
            <p className="text-xl font-semibold text-foreground">{formatUsd(m.currentBalance ?? 0)}</p>
            <p className="text-sm text-slate-400 mt-0.5">{formatInr(m.totalCapitalINR ?? 0)}</p>
          </div>

          {/* Profit */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Net Profit</p>
            <p
              className={`text-xl font-semibold ${
                Number(m.profit) >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
              }`}
            >
              {formatUsd(m.profit ?? 0)}
            </p>
            <p className="text-sm text-slate-400 mt-0.5">
              Profit % {m.profitPercent != null ? formatPct(m.profitPercent) : "—"}
              {m.dailyROI != null ? ` · Daily ROI ${formatPct(m.dailyROI)}` : ""}
            </p>
          </div>

          {/* Volatility */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 sm:col-span-2 lg:col-span-1">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-2">Volatility</p>
            <VolatilityGauge level={vol.level} count={vol.count} />
          </div>
        </div>

        {/* Active positions */}
        <section>
          <h3 className="text-base font-medium text-foreground mb-3">Active Positions</h3>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-6 text-center text-slate-400 text-sm">
              No open pairs. Positions appear when you have the same symbol on both exchanges.
            </div>
          ) : (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[320px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-left text-slate-400">
                      <th className="py-2.5 px-3 font-medium">Symbol</th>
                      <th className="py-2.5 px-3 font-medium text-right">PnL</th>
                      <th className="py-2.5 px-3 font-medium text-right">Margin</th>
                      <th className="py-2.5 px-3 font-medium text-right hidden sm:table-cell">Funding</th>
                      <th className="py-2.5 px-3 w-[100px]" aria-label="Close" />
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((row) => {
                      const pnl = row.combinedUnrealizedProfit ?? 0;
                      const pnlPct = row.combinedPnlPercent;
                      const nextMs =
                        row.nextFundingPayment?.nextFundingTime != null
                          ? row.nextFundingPayment.nextFundingTime - Date.now()
                          : null;
                      return (
                        <tr
                          key={row.symbol}
                          className="border-b border-slate-700/80 last:border-b-0 hover:bg-slate-700/20"
                        >
                          <td className="py-2.5 px-3 font-medium text-foreground max-w-[120px] sm:max-w-none truncate" title={row.symbol}>{row.symbol}</td>
                          <td className="py-2.5 px-3 text-right">
                            <span className={pnl >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"}>
                              {formatUsd(pnl)}
                            </span>
                            {pnlPct != null && (
                              <span className="block text-xs text-slate-400">{formatPct(pnlPct)}</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-300">
                            {formatUsd(row.combinedMarginUsed ?? 0)}
                            <span className="block text-xs text-slate-500 sm:hidden">
                              Fund {formatTimeToFunding(nextMs)}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-400 hidden sm:table-cell">
                            {formatTimeToFunding(nextMs)}
                          </td>
                          <td className="py-2.5 px-3">
                            <button
                              type="button"
                              onClick={() => handleCloseTrade(row.symbol)}
                              disabled={closingSymbol === row.symbol}
                              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--loss)]/20 text-[var(--loss)] hover:bg-[var(--loss)]/30 px-3 py-2.5 text-xs font-medium disabled:opacity-50 touch-manipulation"
                              aria-label={`Close trade ${row.symbol}`}
                            >
                              <XCircle className="w-4 h-4 shrink-0" />
                              <span className="hidden sm:inline">Close</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
