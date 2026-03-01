"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";
import { Search, X } from "lucide-react";

type RankedToken = {
  symbol: string;
  intervalHours?: number;
  intervalDisplay?: "1h" | "2h" | "4h" | "8h";
  netPct: number;
  spreadPctAbs?: number; // combined funding spread (used for backend sort: interval then spread desc)
  nextFundingTime?: number;
  markPrice?: number;
  maxLeverage?: number | null;
  fundingBinance?: number;
  fundingBybit?: number;
  livePriceSpread?: number | null;
  botState?: "Active" | "Last" | "Next" | null;
};

const POLL_MS = 1000;

function formatCountdownHms(ms: number): string {
  if (ms <= 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatFundingRate(val: number | undefined | null): string {
  if (val == null || Number.isNaN(Number(val))) return "—";
  return (Number(val) * 100).toFixed(4) + "%";
}

/** Funding line with explicit sign and (Long) or (Short). */
function formatFundingWithDirection(
  rate: number | undefined | null,
  label: string,
  isLong: boolean
): string {
  if (rate == null || Number.isNaN(Number(rate))) return `${label}: —`;
  const n = Number(rate) * 100;
  const sign = n >= 0 ? "+" : "";
  const dir = isLong ? " (Long)" : " (Short)";
  return `${label}: ${sign}${n.toFixed(4)}%${dir}`;
}

function formatNetPct(val: number | undefined | null): string {
  if (val == null || Number.isNaN(Number(val))) return "—";
  const n = Number(val);
  return (n >= 0 ? "+" : "") + n.toFixed(4) + "%";
}

export default function ScreenerPage() {
  const [data, setData] = useState<{ rankedTokens: RankedToken[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [allowedIntervals, setAllowedIntervals] = useState<number[]>([1, 2, 4, 8]);
  const [minSpreadPct, setMinSpreadPct] = useState<string>("-100");
  const [minL2SpreadFilter, setMinL2SpreadFilter] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("screener_minL2Spread") ?? "";
  });
  const [popupToken, setPopupToken] = useState<RankedToken | null>(null);
  const [quantity, setQuantity] = useState("");
  const [leverage, setLeverage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [metrics, setMetrics] = useState<{
    binanceAvailableBalance?: number;
    bybitAvailableBalance?: number;
  } | null>(null);
  const [bannedTokens, setBannedTokens] = useState<string[]>([]);
  const [coolingTokens, setCoolingTokens] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;
  const [useAdvancedRanking, setUseAdvancedRanking] = useState(false);
  const [rankStepA, setRankStepA] = useState(true);
  const [rankStepB, setRankStepB] = useState(true);
  const [rankStepC, setRankStepC] = useState(true);
  const [savingRanking, setSavingRanking] = useState(false);
  const fetchScreenerRef = useRef<() => void>(() => {});

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    localStorage.setItem("screener_minL2Spread", minL2SpreadFilter);
  }, [minL2SpreadFilter]);

  useEffect(() => {
    if (!popupToken) {
      setMetrics(null);
      return;
    }
    let cancelled = false;
    api
      .get<{ success: boolean; data?: { binanceAvailableBalance?: number; bybitAvailableBalance?: number } }>(
        "/dashboard/metrics"
      )
      .then(({ data }) => {
        if (cancelled || !data?.success || !data?.data) return;
        setMetrics({
          binanceAvailableBalance: data.data.binanceAvailableBalance,
          bybitAvailableBalance: data.data.bybitAvailableBalance,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [popupToken]);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await api.get<{ success?: boolean; rankedTokens?: RankedToken[] }>("/screener");
        const payload = res?.data;
        if (cancelled) return;
        const list = Array.isArray(payload?.rankedTokens) ? payload.rankedTokens : [];
        if (payload?.success !== false) {
          setData({ rankedTokens: list });
        }
      } catch (e) {
        if (!cancelled) toast.error("Failed to load screener data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchScreenerRef.current = () => { fetchData(); };
    fetchData();
    const t = setInterval(fetchData, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    api
      .get<{
        success: boolean;
        data?: {
          useAdvancedRanking?: boolean;
          rankStepA?: boolean;
          rankStepB?: boolean;
          rankStepC?: boolean;
          allowedIntervals?: number[];
          minFundingSpread?: number;
        };
      }>("/settings")
      .then(({ data }) => {
        if (!data?.success || !data?.data) return;
        const d = data.data;
        if (d.useAdvancedRanking !== undefined) setUseAdvancedRanking(d.useAdvancedRanking);
        if (d.rankStepA !== undefined) setRankStepA(d.rankStepA);
        if (d.rankStepB !== undefined) setRankStepB(d.rankStepB);
        if (d.rankStepC !== undefined) setRankStepC(d.rankStepC);
        if (Array.isArray(d.allowedIntervals) && d.allowedIntervals.length > 0) {
          setAllowedIntervals(d.allowedIntervals.filter((n) => [1, 2, 4, 8].includes(Number(n))));
        }
        if (d.minFundingSpread !== undefined) setMinSpreadPct(String(d.minFundingSpread));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchBans = () => {
      api
        .get<{ bannedTokens?: string[]; coolingTokens?: string[] }>("/bans")
        .then(({ data }) => {
          if (cancelled || !data) return;
          setBannedTokens(Array.isArray(data.bannedTokens) ? data.bannedTokens : []);
          setCoolingTokens(Array.isArray(data.coolingTokens) ? data.coolingTokens : []);
        })
        .catch(() => {});
    };
    fetchBans();
    const t = setInterval(fetchBans, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const handleSaveMinFundingSpread = async (val: string) => {
    try {
      await api.put("/settings", { minFundingSpread: Number(val) });
      toast.success("Min Funding Spread updated for Bot!");
    } catch (e) {
      toast.error("Failed to update min funding spread.");
    }
  };

  const handleToggleBan = async (symbol: string, action: "ban" | "unban") => {
    try {
      const { data } = await api.post<{ bannedTokens?: string[] }>("/bans", { symbol, action });
      if (Array.isArray(data?.bannedTokens)) setBannedTokens(data.bannedTokens);
    } catch (e) {
      toast.error("Failed to update ban.");
    }
  };

  const handleRankingToggle = async (
    field: "useAdvancedRanking" | "rankStepA" | "rankStepB" | "rankStepC",
    value: boolean
  ) => {
    const next = {
      useAdvancedRanking: field === "useAdvancedRanking" ? value : useAdvancedRanking,
      rankStepA: field === "rankStepA" ? value : rankStepA,
      rankStepB: field === "rankStepB" ? value : rankStepB,
      rankStepC: field === "rankStepC" ? value : rankStepC,
    };
    setUseAdvancedRanking(next.useAdvancedRanking);
    setRankStepA(next.rankStepA);
    setRankStepB(next.rankStepB);
    setRankStepC(next.rankStepC);
    setSavingRanking(true);
    try {
      await api.put("/settings", {
        useAdvancedRanking: next.useAdvancedRanking,
        rankStepA: next.rankStepA,
        rankStepB: next.rankStepB,
        rankStepC: next.rankStepC,
      });
      fetchScreenerRef.current?.();
    } catch (e) {
      toast.error("Failed to save ranking settings.");
    } finally {
      setSavingRanking(false);
    }
  };

  // Backend returns rankedTokens sorted by interval (1h/2h first, then 4h, 8h) then by combined funding spread (spreadPctAbs) descending. We only filter here, preserving order.
  const filtered = useMemo(() => {
    if (!data?.rankedTokens) return [];
    let list = data.rankedTokens;
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((t) => t.symbol.toLowerCase().includes(q));
    list = list.filter((t) => allowedIntervals.includes(t.intervalHours ?? 8));
    const minSpread = parseFloat(minSpreadPct);
    if (!Number.isNaN(minSpread)) list = list.filter((t) => (t.spreadPctAbs ?? 0) >= minSpread);
    const l2SpreadNum = parseFloat(minL2SpreadFilter);
    if (!Number.isNaN(l2SpreadNum)) {
      list = list.filter((t) => t.livePriceSpread != null && t.livePriceSpread >= l2SpreadNum);
    }
    return list;
  }, [data?.rankedTokens, search, allowedIntervals, minSpreadPct, minL2SpreadFilter]);

  const bannedSet = useMemo(() => new Set(bannedTokens.map((s) => s.toUpperCase())), [bannedTokens]);
  const coolingSet = useMemo(() => new Set(coolingTokens.map((s) => s.toUpperCase())), [coolingTokens]);
  const mainList = useMemo(
    () => filtered.filter((t) => !bannedSet.has(t.symbol.toUpperCase()) && !coolingSet.has(t.symbol.toUpperCase())),
    [filtered, bannedSet, coolingSet]
  );
  const bannedList = useMemo(
    () => filtered.filter((t) => bannedSet.has(t.symbol.toUpperCase()) || coolingSet.has(t.symbol.toUpperCase())),
    [filtered, bannedSet, coolingSet]
  );

  const totalPages = Math.max(1, Math.ceil(mainList.length / itemsPerPage));
  const page = Math.max(1, Math.min(currentPage, totalPages));
  const startIdx = (page - 1) * itemsPerPage;
  const currentItems = mainList.slice(startIdx, startIdx + itemsPerPage);
  /** Token the bot would pick next (first in eligible list: filtered, then minus banned/cooling). */
  const nextTradeToken = mainList[0] ?? null;

  const markPrice = popupToken?.markPrice ?? 0;
  const qtyNum = parseFloat(quantity) || 0;
  const levNum = parseFloat(leverage) || 1;
  const notional = qtyNum * markPrice;
  const marginReq = levNum > 0 ? notional / levNum : 0;

  const handleSubmitOrder = async () => {
    if (!popupToken) return;
    if (qtyNum <= 0 || markPrice <= 0) {
      toast.error("Enter valid quantity and ensure price is available.");
      return;
    }
    const maxLev = popupToken.maxLeverage;
    if (maxLev != null && levNum > maxLev) {
      toast.error(`Max leverage for ${popupToken.symbol} is ${maxLev}x.`);
      return;
    }
    const binFunding = Number(popupToken.fundingBinance);
    const bybFunding = Number(popupToken.fundingBybit);
    const binanceSide = !Number.isNaN(binFunding) && !Number.isNaN(bybFunding) && binFunding > bybFunding ? "SELL" : "BUY";
    const bybitSide = !Number.isNaN(binFunding) && !Number.isNaN(bybFunding) && bybFunding > binFunding ? "Sell" : "Buy";
    setSubmitting(true);
    try {
      await api.post("/trade/arbitrage", {
        symbol: popupToken.symbol,
        quantity: qtyNum,
        leverage: levNum,
        binanceSide,
        bybitSide,
        markPrice,
      });
      toast.success("Arbitrage orders submitted.");
      setPopupToken(null);
      setQuantity("");
      setLeverage("");
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Order failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full min-w-0 max-w-[100vw] overflow-x-hidden px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground mb-3">Screener</h2>

      {/* Filters — line 1: full-width search; line 2: Min Spread % and Interval 50/50 */}
      <div className="flex flex-col gap-2 mb-4">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search token..."
            className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-600 bg-slate-800/50 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm"
          />
        </div>
        <div className="flex w-full gap-2 flex-wrap">
          <label className="flex flex-1 items-center gap-1.5 min-w-0">
            <span className="text-slate-400 text-xs whitespace-nowrap shrink-0">Min Spread %</span>
            <input
              type="number"
              step="any"
              value={minSpreadPct}
              onChange={(e) => setMinSpreadPct(e.target.value)}
              onBlur={(e) => handleSaveMinFundingSpread(e.target.value)}
              placeholder="-100"
              className="flex-1 min-w-0 h-9 px-2 rounded-lg border border-slate-600 bg-slate-800/50 text-foreground text-sm focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            />
          </label>
          <label className="flex flex-1 items-center gap-1.5 min-w-0">
            <span className="text-slate-400 text-xs whitespace-nowrap shrink-0">Min L2 Spread %</span>
            <input
              type="number"
              step="any"
              value={minL2SpreadFilter}
              onChange={(e) => setMinL2SpreadFilter(e.target.value)}
              placeholder="0.15"
              className="flex-1 min-w-0 h-9 px-2 rounded-lg border border-slate-600 bg-slate-800/50 text-foreground text-sm focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            />
          </label>
          <div className="flex flex-1 items-center gap-1.5 flex-wrap">
            <span className="text-slate-400 text-xs whitespace-nowrap shrink-0">Intervals</span>
            {([1, 2, 4, 8] as const).map((h) => {
              const isOn = allowedIntervals.includes(h);
              return (
                <button
                  key={h}
                  type="button"
                  onClick={async () => {
                    const next = isOn
                      ? allowedIntervals.filter((x) => x !== h)
                      : [...allowedIntervals, h].sort((a, b) => a - b);
                    if (next.length === 0) return;
                    setAllowedIntervals(next);
                    try {
                      await api.put("/settings", { allowedIntervals: next });
                    } catch (e) {
                      toast.error("Failed to save interval filter.");
                      setAllowedIntervals(allowedIntervals);
                    }
                  }}
                  className={`h-9 px-2.5 rounded-lg text-xs font-medium border shrink-0 ${
                    isOn
                      ? "bg-[var(--primary)]/20 text-[var(--primary)] border-[var(--primary)]/50"
                      : "bg-slate-800/50 text-slate-500 border-slate-600"
                  }`}
                >
                  {h}h
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Advanced Ranking toggles — persist to settings, refresh screener on change */}
      <section className="mb-4 rounded-xl border border-slate-700 bg-slate-800/50 p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">Ranking system</h3>
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-4 cursor-pointer p-2.5 rounded-lg bg-slate-700/50 hover:bg-slate-700/70 transition-colors">
            <span className="text-sm font-medium text-foreground">Use Advanced Ranking System</span>
            <div className="relative w-12 h-7 flex-shrink-0">
              <input
                type="checkbox"
                checked={useAdvancedRanking}
                disabled={savingRanking}
                onChange={(e) => handleRankingToggle("useAdvancedRanking", e.target.checked)}
                className="sr-only peer"
              />
              <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors" aria-hidden />
              <div className="absolute left-1 top-1 w-5 h-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" aria-hidden />
            </div>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pl-2 border-l-2 border-slate-600">
            <label className="flex items-center justify-between gap-2 cursor-pointer p-2 rounded bg-slate-700/30 hover:bg-slate-700/50">
              <span className="text-xs font-medium text-slate-300">Step A: Funding Persistence</span>
              <div className="relative w-10 h-5 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={rankStepA}
                  disabled={savingRanking}
                  onChange={(e) => handleRankingToggle("rankStepA", e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors" aria-hidden />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" aria-hidden />
              </div>
            </label>
            <label className="flex items-center justify-between gap-2 cursor-pointer p-2 rounded bg-slate-700/30 hover:bg-slate-700/50">
              <span className="text-xs font-medium text-slate-300">Step B: OI Trend Check</span>
              <div className="relative w-10 h-5 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={rankStepB}
                  disabled={savingRanking}
                  onChange={(e) => handleRankingToggle("rankStepB", e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors" aria-hidden />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" aria-hidden />
              </div>
            </label>
            <label className="flex items-center justify-between gap-2 cursor-pointer p-2 rounded bg-slate-700/30 hover:bg-slate-700/50">
              <span className="text-xs font-medium text-slate-300">Step C: Price Stability</span>
              <div className="relative w-10 h-5 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={rankStepC}
                  disabled={savingRanking}
                  onChange={(e) => handleRankingToggle("rankStepC", e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors" aria-hidden />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" aria-hidden />
              </div>
            </label>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader size="medium" label="Loading screener..." />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-500 py-8">No tokens match the filters or data is not ready yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700 -mx-2 sm:mx-0 max-w-[100vw]">
            <table className="w-full text-xs min-w-0">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/50">
                  <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs w-16 sm:w-auto">Token</th>
                  <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Funding</th>
                  <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Spread</th>
                  <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">L2 Spread</th>
                  <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Countdown</th>
                  <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs w-14 sm:w-auto">Action</th>
                </tr>
              </thead>
              <tbody>
                {currentItems.map((row) => {
                  const binNum = Number(row.fundingBinance);
                  const bybNum = Number(row.fundingBybit);
                  const binanceIsLong = !Number.isNaN(binNum) && !Number.isNaN(bybNum) && binNum <= bybNum;
                  const bybitIsLong = !Number.isNaN(binNum) && !Number.isNaN(bybNum) && bybNum <= binNum;
                  const countdownMs = row.nextFundingTime != null ? row.nextFundingTime - now : null;
                  return (
                    <tr key={row.symbol} className="border-b border-slate-700/50">
                      <td className="py-1 px-2 font-medium text-foreground text-[11px] sm:text-xs truncate max-w-[80px] sm:max-w-[120px]" title={row.symbol}>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-100">{row.symbol}</span>
                          {row.botState === "Active" && (
                            <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border border-blue-500/30">
                              Active
                            </span>
                          )}
                          {row.botState === "Last" && (
                            <span className="bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border border-orange-500/30">
                              Last
                            </span>
                          )}
                          {row.botState === "Next" && (
                            <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border border-green-500/30">
                              Next
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1 px-2 text-slate-300 text-[10px] sm:text-xs">
                        <span className="block leading-tight">
                          {formatFundingWithDirection(row.fundingBinance, "Binance", binanceIsLong)}
                        </span>
                        <span className="block leading-tight">
                          {formatFundingWithDirection(row.fundingBybit, "Bybit", bybitIsLong)}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right">
                        <span className="text-[var(--profit)] font-medium">
                          {row.spreadPctAbs != null ? row.spreadPctAbs.toFixed(4) + "%" : "—"}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right">
                        <span className={row.livePriceSpread != null ? (row.livePriceSpread >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]") : "text-slate-500"}>
                          {row.livePriceSpread != null ? (row.livePriceSpread >= 0 ? "+" : "") + row.livePriceSpread.toFixed(4) + "%" : "—"}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-slate-300 text-[10px] sm:text-xs whitespace-nowrap">
                        <span className="block font-medium tabular-nums leading-tight">
                          {countdownMs != null && countdownMs > 0 ? formatCountdownHms(countdownMs) : "—"}
                        </span>
                        <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight" title="Funding interval (1h, 2h, 4h, 8h)">
                          {row.intervalDisplay || "8h"}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right">
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setPopupToken(row);
                              setQuantity("");
                              setLeverage(row.maxLeverage?.toString() ?? "10");
                            }}
                            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center h-9 px-3 rounded-lg text-[10px] sm:text-xs font-medium text-white touch-manipulation"
                            style={{ backgroundColor: "var(--primary)" }}
                          >
                            Trade
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleBan(row.symbol, "ban")}
                            className="min-h-[44px] inline-flex items-center justify-center h-9 px-2 rounded-lg text-[10px] sm:text-xs font-medium text-red-400 border border-red-500/60 bg-red-900/20 hover:bg-red-900/40 touch-manipulation"
                          >
                            Ban
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {mainList.length > 0 && (
            <div className="flex items-center justify-between gap-2 mt-3 text-sm text-slate-400">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800/50 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-700/50"
              >
                Previous
              </button>
              <span className="tabular-nums">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800/50 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-700/50"
              >
                Next
              </button>
            </div>
          )}
          {bannedList.length > 0 && (
            <>
              <h3 className="text-xl font-bold mt-8 mb-4 text-slate-200">Banned & Cooling Tokens</h3>
              <div className="overflow-x-auto rounded-lg border border-slate-700 -mx-2 sm:mx-0 max-w-[100vw]">
                <table className="w-full text-xs min-w-0">
                  <thead>
                    <tr className="border-b border-slate-700 bg-slate-800/50">
                      <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs w-16 sm:w-auto">Token</th>
                      <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Funding</th>
                      <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Spread</th>
                      <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">L2 Spread</th>
                      <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Countdown</th>
                      <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs w-14 sm:w-auto">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bannedList.map((row) => {
                      const binNum = Number(row.fundingBinance);
                      const bybNum = Number(row.fundingBybit);
                      const binanceIsLong = !Number.isNaN(binNum) && !Number.isNaN(bybNum) && binNum <= bybNum;
                      const bybitIsLong = !Number.isNaN(binNum) && !Number.isNaN(bybNum) && bybNum <= binNum;
                      const countdownMs = row.nextFundingTime != null ? row.nextFundingTime - now : null;
                      const isCooling = coolingSet.has(row.symbol.toUpperCase());
                      const isBanned = bannedSet.has(row.symbol.toUpperCase());
                      return (
                        <tr key={row.symbol} className="border-b border-slate-700/50">
                          <td className="py-1 px-2 font-medium text-foreground text-[11px] sm:text-xs truncate max-w-[80px] sm:max-w-[120px]" title={row.symbol}>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-100">{row.symbol}</span>
                              {row.botState === "Active" && (
                                <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border border-blue-500/30">
                                  Active
                                </span>
                              )}
                              {row.botState === "Last" && (
                                <span className="bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border border-orange-500/30">
                                  Last
                                </span>
                              )}
                              {row.botState === "Next" && (
                                <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border border-green-500/30">
                                  Next
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-1 px-2 text-slate-300 text-[10px] sm:text-xs">
                            <span className="block leading-tight">
                              {formatFundingWithDirection(row.fundingBinance, "Binance", binanceIsLong)}
                            </span>
                            <span className="block leading-tight">
                              {formatFundingWithDirection(row.fundingBybit, "Bybit", bybitIsLong)}
                            </span>
                          </td>
                          <td className="py-1 px-2 text-right">
                            <span className="text-[var(--profit)] font-medium">
                              {row.spreadPctAbs != null ? row.spreadPctAbs.toFixed(4) + "%" : "—"}
                            </span>
                          </td>
                          <td className="py-1 px-2 text-right">
                            <span className={row.livePriceSpread != null ? (row.livePriceSpread >= 0 ? "text-[var(--profit)]" : "text-[var(--loss)]") : "text-slate-500"}>
                              {row.livePriceSpread != null ? (row.livePriceSpread >= 0 ? "+" : "") + row.livePriceSpread.toFixed(4) + "%" : "—"}
                            </span>
                          </td>
                          <td className="py-1 px-2 text-slate-300 text-[10px] sm:text-xs whitespace-nowrap">
                            <span className="block font-medium tabular-nums leading-tight">
                              {countdownMs != null && countdownMs > 0 ? formatCountdownHms(countdownMs) : "—"}
                            </span>
                            <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight" title="Funding interval (1h, 2h, 4h, 8h)">
                              {row.intervalDisplay || "8h"}
                            </span>
                          </td>
                          <td className="py-1 px-2 text-right">
                            {isCooling && (
                              <span className="border border-blue-500 text-blue-400 px-2 py-1 rounded text-xs font-bold bg-blue-900/30">
                                Cooling
                              </span>
                            )}
                            {isBanned && (
                              <button
                                type="button"
                                onClick={() => handleToggleBan(row.symbol, "unban")}
                                className="ml-1 inline-flex items-center justify-center h-8 px-2 rounded-lg text-xs font-medium text-slate-200 border border-slate-500 bg-slate-700/50 hover:bg-slate-600/50"
                              >
                                Unban
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* Manual Trade Popup */}
      {popupToken && (
        <div
          className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 safe-area-inset"
          role="dialog"
          aria-modal="true"
          aria-labelledby="manual-trade-title"
          onClick={() => setPopupToken(null)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-[#1e293b] border border-slate-600 border-b-0 sm:border-b shadow-xl max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 flex items-center justify-between p-4 border-b border-slate-600 bg-[#1e293b]">
              <h3 id="manual-trade-title" className="text-base font-semibold text-foreground">
                Manual Trade — {popupToken.symbol}
              </h3>
              <button
                type="button"
                onClick={() => setPopupToken(null)}
                className="p-2 rounded-full text-slate-400 hover:bg-slate-600/50 hover:text-foreground"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="mb-4 p-2 bg-slate-800 rounded text-xs flex justify-between text-slate-300">
                <span>
                  Binance Free:{" "}
                  <span className="text-amber-400 font-bold">
                    ${metrics?.binanceAvailableBalance?.toFixed(2) ?? "0.00"}
                  </span>
                </span>
                <span>
                  Bybit Free:{" "}
                  <span className="text-sky-400 font-bold">
                    ${metrics?.bybitAvailableBalance?.toFixed(2) ?? "0.00"}
                  </span>
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Mark price: {popupToken.markPrice != null && !Number.isNaN(Number(popupToken.markPrice))
                  ? Number(popupToken.markPrice).toFixed(2)
                  : "—"}
              </p>
              {(() => {
                const bin = Number(popupToken.fundingBinance);
                const byb = Number(popupToken.fundingBybit);
                const actionText =
                  !Number.isNaN(bin) && !Number.isNaN(byb) && bin > byb
                    ? "Short Binance & Long Bybit"
                    : !Number.isNaN(bin) && !Number.isNaN(byb) && byb > bin
                      ? "Long Binance & Short Bybit"
                      : "Long Binance & Short Bybit";
                return (
                  <p className="text-sm font-medium text-foreground rounded-lg bg-slate-800/70 px-3 py-2">
                    {actionText}
                  </p>
                );
              })()}
              <label className="block">
                <span className="text-sm text-slate-400 mb-1 block">Quantity</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="0"
                  className="w-full h-10 rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm"
                />
              </label>
              <label className="block">
                <span className="text-sm text-slate-400 mb-1 block">Leverage</span>
                <input
                  type="number"
                  min="1"
                  max={popupToken.maxLeverage ?? 100}
                  value={leverage}
                  onChange={(e) => setLeverage(e.target.value)}
                  placeholder="10"
                  className="w-full h-10 rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm"
                />
                {popupToken.maxLeverage != null && (
                  <p className="text-xs text-slate-500 mt-1">Max: {popupToken.maxLeverage}x</p>
                )}
              </label>
              {/* Margin calculation: Margin = (Price × Quantity) / Leverage */}
              <div className="rounded-lg bg-slate-800/70 p-3">
                <p className="text-xs text-slate-400 mb-1">
                  Margin = (Price × Quantity) / Leverage
                </p>
                <p className="text-lg font-medium text-foreground">
                  {marginReq > 0 ? `${marginReq.toFixed(2)} USDT` : "—"}
                </p>
                {notional > 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    Price × Quantity = {notional.toFixed(2)} USDT
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={handleSubmitOrder}
                disabled={submitting || qtyNum <= 0 || markPrice <= 0}
                className="w-full h-11 rounded-lg font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: "var(--primary)" }}
              >
                {submitting ? "Submitting..." : "Submit arbitrage orders"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
