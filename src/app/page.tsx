"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";
import { XCircle, ChevronDown, ChevronRight } from "lucide-react";

function getSocketOrigin(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") {
    if (window.location.hostname === "tradeictearner.online") return "https://tradeictearner.online";
    return window.location.origin;
  }
  return "http://localhost:5000";
}

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
  entryPrice: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
  markPrice: number | null;
  fundingRate: number | null;
  fundingRatePct: number | null;
  nextFundingAmount: number;
  exchangeFees: number;
};

type PositionRow = {
  symbol: string;
  isFundingFlipped?: boolean;
  binance: PositionLeg;
  bybit: PositionLeg;
  combinedUnrealizedProfit: number;
  combinedMarginUsed: number;
  combinedPnlPercent: number | null;
  totalNextFundingAmount: number;
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
  const size = 88;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const arcLen = Math.PI * r;
  const third = arcLen / 3;
  const needleAngleDeg = (normalized / 100) * 180;
  const needleRotation = needleAngleDeg - 90;

  const semicirclePath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size / 2 + stroke }}>
        <svg width={size} height={size / 2 + stroke} viewBox={`0 0 ${size} ${size / 2 + stroke}`} className="overflow-visible">
          <path d={semicirclePath} fill="none" stroke="#334155" strokeWidth={stroke} strokeLinecap="round" opacity={0.4} />
          <path d={semicirclePath} fill="none" stroke="var(--profit)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${third} ${arcLen}`} strokeDashoffset={0} />
          <path d={semicirclePath} fill="none" stroke="#eab308" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${third} ${arcLen}`} strokeDashoffset={-third} />
          <path d={semicirclePath} fill="none" stroke="var(--loss)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${third} ${arcLen}`} strokeDashoffset={-2 * third} />
          <g transform={`translate(${cx}, ${cy}) rotate(${needleRotation})`}>
            <line x1={0} y1={0} x2={0} y2={-r + stroke} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" className="text-slate-200" />
          </g>
        </svg>
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

type PositionsResponse = { success: boolean; data?: PositionRow[]; grandTotalPnl?: number; grandTotalNextFundingAmount?: number };

export default function Home() {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [grandTotalNextFunding, setGrandTotalNextFunding] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const grandTotalPnl = useMemo(
    () => positions.reduce((s, p) => s + (p.combinedUnrealizedProfit ?? 0), 0),
    [positions]
  );
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);

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
      const res = await api.get<PositionsResponse>("/dashboard/positions");
      const raw = res.data?.success ? res.data.data : undefined;
      const list = Array.isArray(raw)
        ? raw.filter(
            (p): p is PositionRow =>
              p != null && typeof p.symbol === "string" && (p.binance != null || p.bybit != null)
          )
        : [];
      setPositions(list);
      setGrandTotalNextFunding(Number(res.data?.grandTotalNextFundingAmount) || 0);
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
    const intervalId = setInterval(() => {
      fetchMetrics();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [fetchMetrics, fetchPositions]);

  useEffect(() => {
    const { io } = require("socket.io-client");
    const socket = io("/", { path: "/socket.io" });
    socket.on("live_pnl_update", (payload: { symbol: string; binancePnL: number; bybitPnL: number; combinedPnL: number; binanceMarkPrice?: number; bybitMarkPrice?: number }) => {
      const { symbol, binancePnL, bybitPnL, combinedPnL, binanceMarkPrice, bybitMarkPrice } = payload ?? {};
      if (!symbol) return;
      setPositions((prev) =>
        prev.map((row) => {
          if (row.symbol !== symbol) return row;
          const nextBinance = {
            ...row.binance,
            unrealizedProfit: (payload.binancePnL != null && !Number.isNaN(Number(payload.binancePnL))) ? payload.binancePnL : row.binance.unrealizedProfit,
            ...(binanceMarkPrice != null && Number.isFinite(binanceMarkPrice) ? { markPrice: binanceMarkPrice } : {}),
          };
          const nextBybit = {
            ...row.bybit,
            unrealizedProfit: (payload.bybitPnL != null && !Number.isNaN(Number(payload.bybitPnL))) ? payload.bybitPnL : row.bybit.unrealizedProfit,
            ...(bybitMarkPrice != null && Number.isFinite(bybitMarkPrice) ? { markPrice: bybitMarkPrice } : {}),
          };
          return {
            ...row,
            combinedUnrealizedProfit: (payload.combinedPnL != null && !Number.isNaN(Number(payload.combinedPnL))) ? payload.combinedPnL : row.combinedUnrealizedProfit,
            binance: nextBinance,
            bybit: nextBybit,
          };
        })
      );
    });
    return () => {
      socket.disconnect();
    };
  }, []);

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
          {/* Capital — display only: +$1500 per exchange; backend/API unchanged */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Capital</p>
            <p className="text-xl font-semibold text-foreground">
              {formatUsd((m.binanceBalance ?? 0) + 1500 + (m.bybitBalance ?? 0) + 1500)}
            </p>
            <p className="text-sm text-slate-400 mt-0.5">Opening Balance: $3450</p>
          </div>

          {/* Profit — display: Total Capital - 3450 - today deposit - today withdrawal; opening balance hardcoded */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Net Profit</p>
            {(() => {
              const OPENING_BALANCE = 3450;
              const todaysDeposit = 0;
              const todaysWithdrawal = 0;
              const totalCapitalDisplay = (m.binanceBalance ?? 0) + 1500 + (m.bybitBalance ?? 0) + 1500;
              const netProfitDisplay = totalCapitalDisplay - OPENING_BALANCE - todaysDeposit - todaysWithdrawal;
              return (
                <>
                  <p
                    className={`text-xl font-semibold ${
                      netProfitDisplay >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                    }`}
                  >
                    {formatUsd(netProfitDisplay)}
                  </p>
                  <p className="text-sm text-slate-400 mt-0.5">
                    Profit % {m.profitPercent != null ? formatPct(m.profitPercent) : "—"}
                    {m.dailyROI != null ? ` · Daily ROI ${formatPct(m.dailyROI)}` : ""}
                  </p>
                </>
              );
            })()}
          </div>

          {/* Volatility */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 sm:col-span-2 lg:col-span-1">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-2">Volatility</p>
            <VolatilityGauge level={vol.level} count={vol.count} />
          </div>
        </div>

        {/* Active positions — expandable accordion */}
        <section>
          <h3 className="text-base font-medium text-foreground mb-3">Active Positions</h3>
          {positions.length === 0 ? (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-6 text-center text-slate-400 text-sm">
              No open positions.
            </div>
          ) : (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 overflow-hidden">
              {/* Panel header: grand totals */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-700 bg-slate-800/50">
                <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wider">Grand Total PnL</p>
                    <p
                      className={`text-lg font-semibold transition-colors duration-150 ${
                        grandTotalPnl >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                      }`}
                    >
                      {formatUsd(grandTotalPnl)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wider">Grand Total Next Funding</p>
                    <p
                      className={`text-lg font-semibold ${
                        grandTotalNextFunding >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                      }`}
                    >
                      {formatUsd(grandTotalNextFunding)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Token accordion list */}
              <div className="divide-y divide-slate-700/80">
                {positions.map((row) => {
                  const isExpanded = expandedSymbol === row.symbol;
                  const pnl = row.combinedUnrealizedProfit ?? 0;
                  const totalFunding = row.totalNextFundingAmount ?? 0;
                  return (
                    <div key={row.symbol} className="bg-slate-800/20">
                      {/* Token bar (group header) */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedSymbol(isExpanded ? null : row.symbol)}
                        onKeyDown={(e) =>
                          (e.key === "Enter" || e.key === " ") && setExpandedSymbol(isExpanded ? null : row.symbol)
                        }
                        className="flex flex-wrap items-center gap-2 sm:gap-4 px-4 py-3 hover:bg-slate-700/20 cursor-pointer touch-manipulation min-h-[52px]"
                        aria-expanded={isExpanded}
                      >
                        <span className="flex-shrink-0 text-slate-400" aria-hidden>
                          {isExpanded ? (
                            <ChevronDown className="w-5 h-5" />
                          ) : (
                            <ChevronRight className="w-5 h-5" />
                          )}
                        </span>
                        <span className="font-medium text-foreground min-w-[80px]">{row.symbol}</span>
                        {row.isFundingFlipped && (
                          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-400 border border-amber-500/40" title="Next funding will be a payment (negative); consider exiting before funding.">
                            ⚠️ Funding Flipped
                          </span>
                        )}
                        <span
                          className={`font-medium transition-colors duration-150 ${
                            pnl >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                          }`}
                        >
                          {formatUsd(pnl)}
                        </span>
                        <span className={`text-sm font-medium ${(totalFunding ?? 0) >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"}`}>
                          Next fund: {formatUsd(totalFunding)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCloseTrade(row.symbol);
                          }}
                          disabled={closingSymbol === row.symbol}
                          className="ml-auto flex-shrink-0 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--loss)]/20 text-[var(--loss)] hover:bg-[var(--loss)]/30 px-3 py-2 text-xs font-medium disabled:opacity-50 touch-manipulation"
                          aria-label={`Exit ${row.symbol}`}
                        >
                          <XCircle className="w-4 h-4 shrink-0" />
                          Exit
                        </button>
                      </div>

                      {/* Expanded details: Binance + Bybit rows */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-0 border-t border-slate-700/60">
                          <div className="overflow-x-auto -mx-4 px-4">
                            <table className="w-full text-sm min-w-[640px]">
                              <thead>
                                <tr className="text-left text-slate-400 border-b border-slate-700">
                                  <th className="py-2 pr-2 font-medium">Exchange</th>
                                  <th className="py-2 pr-2 font-medium">Direction</th>
                                  <th className="py-2 pr-2 font-medium text-right">Entry</th>
                                  <th className="py-2 pr-2 font-medium text-right">Qty</th>
                                  <th className="py-2 pr-2 font-medium text-right">Leverage</th>
                                  <th className="py-2 pr-2 font-medium text-right">Mark</th>
                                  <th className="py-2 pr-2 font-medium text-right">Funding %</th>
                                  <th className="py-2 pr-2 font-medium text-right">Liq. Price</th>
                                  <th className="py-2 pr-2 font-medium text-right">PnL</th>
                                  <th className="py-2 pr-2 font-medium text-right">Next Fund</th>
                                  <th className="py-2 font-medium text-right">Fees</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[
                                  { name: "Binance", leg: row.binance },
                                  { name: "Bybit", leg: row.bybit },
                                ].map(({ name, leg }) => {
                                  const safeLeg = leg ?? {
                                    side: "NONE",
                                    positionAmt: 0,
                                    unrealizedProfit: 0,
                                    marginUsed: 0,
                                    entryPrice: null,
                                    leverage: null,
                                    liquidationPrice: null,
                                    markPrice: null,
                                    fundingRate: null,
                                    fundingRatePct: null,
                                    nextFundingAmount: 0,
                                    exchangeFees: 0,
                                  };
                                  return (
                                    <tr key={name} className="border-b border-slate-700/50 last:border-b-0">
                                      <td className="py-2 pr-2 text-foreground font-medium">{name}</td>
                                      <td className="py-2 pr-2">
                                        <span
                                          className={
                                            String(safeLeg.side).toUpperCase() === "BUY" || safeLeg.side === "Buy"
                                              ? "text-[var(--profit)]"
                                              : String(safeLeg.side).toUpperCase() === "NONE"
                                                ? "text-slate-500"
                                                : "text-[var(--loss)]"
                                          }
                                        >
                                          {safeLeg.side ?? "—"}
                                        </span>
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.entryPrice != null && Number.isFinite(safeLeg.entryPrice)
                                          ? Number(safeLeg.entryPrice).toFixed(2)
                                          : "—"}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.positionAmt ?? 0}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.leverage != null && Number.isFinite(safeLeg.leverage)
                                          ? safeLeg.leverage
                                          : "—"}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.markPrice != null && Number.isFinite(safeLeg.markPrice)
                                          ? Number(safeLeg.markPrice).toFixed(2)
                                          : "—"}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.fundingRatePct != null && Number.isFinite(safeLeg.fundingRatePct)
                                          ? Number(safeLeg.fundingRatePct).toFixed(4) + "%"
                                          : "—"}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.liquidationPrice != null && Number.isFinite(safeLeg.liquidationPrice)
                                          ? Number(safeLeg.liquidationPrice).toFixed(2)
                                          : "—"}
                                      </td>
                                      <td
                                        className={`py-2 pr-2 text-right font-medium transition-colors duration-150 ${
                                          (safeLeg.unrealizedProfit ?? 0) >= 0
                                            ? "text-[var(--profit)]"
                                            : "text-[var(--loss)]"
                                        }`}
                                      >
                                        {formatUsd(safeLeg.unrealizedProfit ?? 0)}
                                      </td>
                                      <td
                                        className={`py-2 pr-2 text-right font-medium ${
                                          (safeLeg.nextFundingAmount ?? 0) >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                                        }`}
                                      >
                                        {formatUsd(safeLeg.nextFundingAmount ?? 0)}
                                      </td>
                                      <td className="py-2 text-right text-slate-400">
                                        {formatUsd(safeLeg.exchangeFees ?? 0)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
