"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import toast from "react-hot-toast";
import api, { getSocketOrigin } from "@/lib/api";
import { Loader } from "@/components/Loader";
import { XCircle, ChevronDown, ChevronRight } from "lucide-react";

type VolatilityMeter = { level: string; count?: number };

type MetricsData = {
  binanceBalance: number;
  bybitBalance: number;
  totalCapital?: number;
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
  binanceAvailableBalance?: number;
  bybitAvailableBalance?: number;
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
  l2SpreadVwap?: number | null;
  screenerTradeNotional?: number | null;
  binance: PositionLeg;
  bybit: PositionLeg;
  combinedUnrealizedProfit: number;
  combinedMarginUsed: number;
  combinedPnlPercent: number | null;
  totalNextFundingAmount: number;
  nextFundingPayment: { nextFundingTime: number; nextFundingTimeISO: string } | null;
  targetAmount?: number;
  stopLossAmount?: number;
  lastUpdated?: number;
};

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(n);
}

function formatUsdStandard(n: number): string {
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
  const [wsStatus, setWsStatus] = useState<"live" | "delayed" | "dead">("dead");
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
      // Do NOT call fetchPositions() here - it would overwrite live WebSocket PnL with stale REST data
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [fetchMetrics, fetchPositions]);

  const latestPnlRef = useRef<Record<string, any>>({});
  const wsLastTickRef = useRef<number>(0);

  useEffect(() => {
    const { io } = require("socket.io-client");

    const apiUrl = getSocketOrigin();
    console.log("🔌 Attempting socket connection to:", apiUrl);

    const socket = io(apiUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      console.log("🟢 Frontend WS Connected to Backend! ID:", socket.id);
      socket.emit("request_live_pnl");
    });

    socket.on("connect_error", (err: any) => {
      console.error("🔴 WS Connection Error:", err.message);
    });

    socket.on("live_pnl_update", (payload: any) => {
      if (!payload || !payload.symbol) return;
      console.log(`[WS-RECEIVE] ⚡ ${payload.symbol} | PnL: ${payload.combinedPnL}`);
      latestPnlRef.current[payload.symbol] = payload;
      wsLastTickRef.current = Date.now();
    });

    socket.on("position_closed", (payload: { symbol: string }) => {
      if (payload?.symbol) {
        setPositions((prev) => prev.filter((row) => row.symbol !== payload.symbol));
        setExpandedSymbol((prev) => (prev === payload.symbol ? null : prev));
      }
    });

    const renderInterval = setInterval(() => {
      const currentPayloads = { ...latestPnlRef.current };
      latestPnlRef.current = {}; // Clear BEFORE setState to prevent race condition
      if (Object.keys(currentPayloads).length > 0) {
        setPositions((prev) =>
          prev.map((row) => {
            const up = currentPayloads[row.symbol];
            if (!up) return row;
            return {
              ...row,
              combinedUnrealizedProfit: Number.isFinite(up.combinedPnL) ? up.combinedPnL : row.combinedUnrealizedProfit,
              lastUpdated: Date.now(),
              binance: {
                ...row.binance,
                unrealizedProfit: Number.isFinite(up.binancePnL) ? up.binancePnL : row.binance.unrealizedProfit,
                markPrice: up.binanceMarkPrice ?? row.binance.markPrice,
              },
              bybit: {
                ...row.bybit,
                unrealizedProfit: Number.isFinite(up.bybitPnL) ? up.bybitPnL : row.bybit.unrealizedProfit,
                markPrice: up.bybitMarkPrice ?? row.bybit.markPrice,
              },
            };
          })
        );
      }
    }, 100);

    return () => {
      socket.disconnect();
      clearInterval(renderInterval);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const diff = Date.now() - wsLastTickRef.current;
      if (diff < 3000) setWsStatus("live");
      else if (diff < 10000) setWsStatus("delayed");
      else setWsStatus("dead");
    }, 1000);
    return () => clearInterval(interval);
  }, []); // Empty dependency array prevents the livelock

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
          {/* Capital — totalCapital from backend; opening balance fixed at 3450 */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Capital</p>
            <p className="text-xl font-semibold text-foreground">
              {formatUsdStandard(m.totalCapital ?? (m.binanceBalance ?? 0) + (m.bybitBalance ?? 0))}
            </p>
            <p className="text-sm text-slate-400 mt-0.5">Opening Balance: $3,450.00</p>
          </div>

          {/* Profit — from backend (totalCapital, openingBalance, profit, profitPercent) */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Net Profit</p>
            <p
              className={`text-xl font-semibold ${
                (m.profit ?? 0) >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
              }`}
            >
              {formatUsdStandard(m.profit ?? 0)}
            </p>
            <p className="text-sm text-slate-400 mt-0.5">
              Profit % {m.profitPercent != null ? `${m.profitPercent.toFixed(2)}%` : "—"}
              {m.dailyROI != null ? ` · Daily ROI ${formatPct(m.dailyROI)}` : ""}
            </p>
          </div>

          {/* Volatility */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4 sm:col-span-2 lg:col-span-1">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-2">Volatility</p>
            <VolatilityGauge level={vol.level} count={vol.count} />
          </div>
        </div>

        {/* Active positions — expandable accordion */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-base font-medium text-foreground">Active Positions</h3>
            <span
              className={`w-2 h-2 rounded-full ${
                wsStatus === "live"
                  ? "bg-green-500 animate-pulse"
                  : wsStatus === "delayed"
                    ? "bg-yellow-500"
                    : "bg-red-500"
              }`}
              title={`WS Status: ${wsStatus}`}
            />
          </div>
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
                    <p className="text-xs text-slate-400 uppercase tracking-wider">TOTAL PnL</p>
                    <p
                      className={`text-lg font-semibold transition-colors duration-150 ${
                        grandTotalPnl >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                      }`}
                    >
                      {Number.isFinite(grandTotalPnl) ? `$${Number(grandTotalPnl).toFixed(2)}` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wider">Total Nxt FR</p>
                    <p
                      className={`text-lg font-semibold ${
                        grandTotalNextFunding >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                      }`}
                    >
                      {Number.isFinite(grandTotalNextFunding) ? `$${Number(grandTotalNextFunding).toFixed(2)}` : "—"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Token accordion list */}
              <div className="divide-y divide-slate-700/80">
                {positions.map((row) => {
                  const isExpanded = expandedSymbol === row.symbol;
                  const pnl = row.combinedUnrealizedProfit ?? 0;
                  const groupPnl = Number(row.binance?.unrealizedProfit ?? 0) + Number(row.bybit?.unrealizedProfit ?? 0);
                  const targetAmount = Number(row.targetAmount ?? 1);
                  const stopLossAmount = Number(row.stopLossAmount ?? 1);
                  const profitWidth = groupPnl > 0 ? Math.min((groupPnl / targetAmount) * 100, 100) : 0;
                  const lossWidth = groupPnl < 0 ? Math.min((Math.abs(groupPnl) / stopLossAmount) * 100, 100) : 0;
                  const binanceIncome = parseFloat(String(row.binance?.nextFundingAmount ?? 0)) || 0;
                  const bybitIncome = parseFloat(String(row.bybit?.nextFundingAmount ?? 0)) || 0;
                  const totalFunding = binanceIncome + bybitIncome;
                  const isFlipped = totalFunding < 0;
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
                        {row.l2SpreadVwap != null && Number.isFinite(row.l2SpreadVwap) && (
                          <span className={`text-xs font-medium ${row.l2SpreadVwap >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"}`}>
                            L2 VWAP (${row.screenerTradeNotional ?? 500}): {(row.l2SpreadVwap >= 0 ? "+" : "") + row.l2SpreadVwap.toFixed(2)}%
                          </span>
                        )}
                        <span
                          className={`text-sm font-medium ${(totalFunding ?? 0) >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"}`}
                        >
                          Nxt FR:{" "}
                          {Number.isFinite(totalFunding) ? `$${Number(totalFunding).toFixed(2)}` : "—"}
                        </span>
                        {isFlipped && (
                          <span className="ml-2 px-1.5 py-0.5 text-[10px] uppercase font-bold tracking-wider text-red-100 bg-red-900/50 border border-red-800 rounded">
                            FR Flip
                          </span>
                        )}
                        <span
                          className={`font-medium transition-colors duration-150 ${
                            pnl >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]"
                          }`}
                        >
                          {Number.isFinite(pnl) ? `$${Number(pnl).toFixed(4)}` : "—"}
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

                      {/* Target / Stoploss progress meter */}
                      <div className="w-full px-4 py-3 bg-slate-900/50 border-t border-slate-800">
                        <div className="flex justify-between text-[10px] uppercase font-bold tracking-wider mb-1.5">
                          <span className="text-red-400/80">SL -${stopLossAmount.toFixed(2)}</span>
                          <span className={groupPnl >= 0 ? "text-green-400" : "text-red-400"}>
                            {groupPnl >= 0 ? "+" : ""}{groupPnl.toFixed(2)}
                          </span>
                          <span className="text-green-400/80">TP +${targetAmount.toFixed(2)}</span>
                        </div>
                        <div className="flex w-full h-2.5 bg-slate-800 rounded-full overflow-hidden relative">
                          <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-slate-500 z-10" />
                          <div className="w-1/2 h-full flex justify-end border-r border-slate-700/50">
                            <div
                              className="h-full bg-gradient-to-l from-red-500 to-red-600 transition-all duration-500 ease-in-out"
                              style={{ width: `${lossWidth}%` }}
                            />
                          </div>
                          <div className="w-1/2 h-full flex justify-start">
                            <div
                              className="h-full bg-gradient-to-r from-green-500 to-green-600 transition-all duration-500 ease-in-out"
                              style={{ width: `${profitWidth}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Expanded details: Binance + Bybit rows */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-0 border-t border-slate-700/60">
                          <div className="overflow-x-auto -mx-4 px-4">
                            <table className="w-full text-sm min-w-[640px]">
                              <thead>
                                <tr className="text-left text-slate-400 border-b border-slate-700">
                                  <th className="py-2 pr-2 font-medium">Exch</th>
                                  <th className="py-2 pr-2 font-medium">Trade</th>
                                  <th className="py-2 pr-2 font-medium text-right">Entry</th>
                                  <th className="py-2 pr-2 font-medium text-right">Qty</th>
                                  <th className="py-2 pr-2 font-medium text-right">Mark</th>
                                  <th className="py-2 pr-2 font-medium text-right">FR</th>
                                  <th className="py-2 pr-2 font-medium text-right">Liq</th>
                                  <th className="py-2 pr-2 font-medium text-right">PnL</th>
                                  <th className="py-2 font-medium text-right">Nxt FR</th>
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
                                        {String(safeLeg.side).toUpperCase() === "NONE" ? (
                                          <span className="text-slate-500">—</span>
                                        ) : (
                                          <div
                                            className={`w-6 h-6 flex items-center justify-center rounded text-white font-bold text-xs ${
                                              safeLeg.side?.toLowerCase() === "buy" ? "bg-green-600" : "bg-red-600"
                                            }`}
                                          >
                                            {safeLeg.side?.toLowerCase() === "buy" ? "B" : "S"}
                                          </div>
                                        )}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.entryPrice != null && Number.isFinite(safeLeg.entryPrice)
                                          ? Number(safeLeg.entryPrice).toLocaleString(undefined, {
                                              maximumFractionDigits: 6,
                                            })
                                          : "—"}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.positionAmt ?? 0}
                                      </td>
                                      <td className="py-2 pr-2 text-right text-slate-300">
                                        {safeLeg.markPrice != null && Number.isFinite(safeLeg.markPrice)
                                          ? Number(safeLeg.markPrice).toLocaleString(undefined, {
                                              maximumFractionDigits: 6,
                                            })
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
                                        $
                                        {Number(safeLeg.unrealizedProfit ?? 0).toFixed(4)}
                                      </td>
                                      <td
                                        className={`py-2 pr-2 text-right font-medium ${
                                          (safeLeg.nextFundingAmount ?? 0) >= 0
                                            ? "text-[var(--profit)]"
                                            : "text-[var(--loss)]"
                                        }`}
                                      >
                                        $
                                        {Number(safeLeg.nextFundingAmount ?? 0).toFixed(2)}
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
