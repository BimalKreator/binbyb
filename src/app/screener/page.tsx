"use client";

import { useState, useEffect, useMemo } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";
import { Search, X } from "lucide-react";

type RankedToken = {
  symbol: string;
  intervalHours?: number;
  netPct: number;
  nextFundingTime?: number;
  markPrice?: number;
  maxLeverage?: number | null;
  fundingBinance?: number;
  fundingBybit?: number;
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
  if (val == null || Number.isNaN(Number(val))) return "Loading...";
  return (Number(val) * 100).toFixed(4) + "%";
}

/** Funding line with explicit sign and (Long) or (Short). */
function formatFundingWithDirection(
  rate: number | undefined | null,
  label: string,
  isLong: boolean
): string {
  if (rate == null || Number.isNaN(Number(rate))) return `${label}: Loading...`;
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
  const [intervalFilter, setIntervalFilter] = useState<number | null>(null);
  const [minSpreadPct, setMinSpreadPct] = useState<string>("-100");
  const [popupToken, setPopupToken] = useState<RankedToken | null>(null);
  const [quantity, setQuantity] = useState("");
  const [leverage, setLeverage] = useState("");
  const [exchange, setExchange] = useState<"binance" | "bybit">("binance");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await api.get<{ success?: boolean; rankedTokens?: RankedToken[] }>("/screener");
        const payload = res?.data;
        console.log("API Response:", payload);
        if (cancelled) return;
        const list = Array.isArray(payload?.rankedTokens) ? payload.rankedTokens : [];
        if (payload?.success !== false) {
          setData({ rankedTokens: list });
        }
      } catch (e) {
        console.log("[Screener] Fetch error:", e);
        if (!cancelled) toast.error("Failed to load screener data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    const t = setInterval(fetchData, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!data?.rankedTokens) return [];
    let list = data.rankedTokens;
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((t) => t.symbol.toLowerCase().includes(q));
    if (intervalFilter != null) list = list.filter((t) => t.intervalHours === intervalFilter);
    const minSpread = parseFloat(minSpreadPct);
    if (!Number.isNaN(minSpread)) list = list.filter((t) => t.netPct >= minSpread);
    return list;
  }, [data?.rankedTokens, search, intervalFilter, minSpreadPct]);

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
    setSubmitting(true);
    try {
      await api.post("/orders", {
        exchange,
        symbol: popupToken.symbol,
        side,
        quantity: qtyNum,
        price: markPrice,
      });
      toast.success("Order submitted.");
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
    <div className="w-full max-w-[100vw] overflow-x-hidden px-4 py-4">
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
        <div className="flex w-full gap-2">
          <label className="flex flex-1 items-center gap-1.5 min-w-0">
            <span className="text-slate-400 text-xs whitespace-nowrap shrink-0">Min Spread %</span>
            <input
              type="number"
              step="any"
              value={minSpreadPct}
              onChange={(e) => setMinSpreadPct(e.target.value)}
              placeholder="-100"
              className="flex-1 min-w-0 h-9 px-2 rounded-lg border border-slate-600 bg-slate-800/50 text-foreground text-sm focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            />
          </label>
          <select
            value={intervalFilter ?? ""}
            onChange={(e) => setIntervalFilter(e.target.value === "" ? null : Number(e.target.value))}
            className="flex-1 min-w-0 h-9 px-2 rounded-lg border border-slate-600 bg-slate-800/50 text-foreground text-xs focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          >
            <option value="">All intervals</option>
            <option value="1">1h</option>
            <option value="2">2h</option>
            <option value="4">4h</option>
            <option value="8">8h</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader size="medium" label="Loading screener..." />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-500 py-8">No tokens match the filters or data is not ready yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700 -mx-2 sm:mx-0">
          <table className="w-full text-xs min-w-0">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-800/50">
                <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs w-16 sm:w-auto">Token</th>
                <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Funding</th>
                <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Spread</th>
                <th className="text-left py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs">Countdown</th>
                <th className="text-right py-1 px-2 text-slate-400 font-medium text-[10px] sm:text-xs w-14 sm:w-auto">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const binNum = Number(row.fundingBinance);
                const bybNum = Number(row.fundingBybit);
                const binanceIsLong = !Number.isNaN(binNum) && !Number.isNaN(bybNum) && binNum <= bybNum;
                const bybitIsLong = !Number.isNaN(binNum) && !Number.isNaN(bybNum) && bybNum <= binNum;
                const countdownMs = row.nextFundingTime != null ? row.nextFundingTime - now : null;
                const netPctNum = Number(row.netPct);
                const hasNetPct = !Number.isNaN(netPctNum);
                return (
                  <tr key={row.symbol} className="border-b border-slate-700/50">
                    <td className="py-1 px-2 font-medium text-foreground text-[11px] sm:text-xs truncate" title={row.symbol}>{row.symbol}</td>
                    <td className="py-1 px-2 text-slate-300 text-[10px] sm:text-xs">
                      <span className="block leading-tight">
                        {formatFundingWithDirection(row.fundingBinance, "Binance", binanceIsLong)}
                      </span>
                      <span className="block leading-tight">
                        {formatFundingWithDirection(row.fundingBybit, "Bybit", bybitIsLong)}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-right">
                      <span
                        className={
                          hasNetPct && netPctNum >= 0 ? "text-[var(--profit)]" : hasNetPct ? "text-[var(--loss)]" : "text-slate-500"
                        }
                      >
                        {formatNetPct(row.netPct)}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-slate-300 text-[10px] sm:text-xs whitespace-nowrap">
                      {countdownMs != null && countdownMs > 0 ? (
                        <>
                          <span className="block font-medium tabular-nums leading-tight">
                            {formatCountdownHms(countdownMs)}
                          </span>
                          <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight">
                            {row.intervalHours != null ? `${row.intervalHours}h` : "—"}
                          </span>
                        </>
                      ) : row.nextFundingTime != null ? (
                        <>
                          <span className="block font-medium tabular-nums leading-tight">—</span>
                          <span className="block text-[10px] text-slate-500 mt-0.5 leading-tight">
                            {row.intervalHours != null ? `${row.intervalHours}h` : "—"}
                          </span>
                        </>
                      ) : (
                        "Loading..."
                      )}
                    </td>
                    <td className="py-1 px-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setPopupToken(row);
                          setQuantity("");
                          setLeverage(row.maxLeverage?.toString() ?? "10");
                          setSide("BUY");
                        }}
                        className="h-7 px-2 rounded-lg text-[10px] sm:text-xs font-medium text-white"
                        style={{ backgroundColor: "var(--primary)" }}
                      >
                        Trade
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
              <p className="text-xs text-slate-400">
                Mark price: {popupToken.markPrice != null && !Number.isNaN(Number(popupToken.markPrice))
                  ? Number(popupToken.markPrice).toFixed(2)
                  : "Loading..."}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSide("BUY")}
                  className={`flex-1 h-10 rounded-lg text-sm font-medium ${
                    side === "BUY" ? "text-white" : "text-slate-400 bg-slate-700/50"
                  }`}
                  style={side === "BUY" ? { backgroundColor: "var(--profit)" } : undefined}
                >
                  Long
                </button>
                <button
                  type="button"
                  onClick={() => setSide("SELL")}
                  className={`flex-1 h-10 rounded-lg text-sm font-medium ${
                    side === "SELL" ? "text-white" : "text-slate-400 bg-slate-700/50"
                  }`}
                  style={side === "SELL" ? { backgroundColor: "var(--loss)" } : undefined}
                >
                  Short
                </button>
              </div>
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
              <label className="block">
                <span className="text-sm text-slate-400 mb-1 block">Exchange</span>
                <select
                  value={exchange}
                  onChange={(e) => setExchange(e.target.value as "binance" | "bybit")}
                  className="w-full h-10 rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm"
                >
                  <option value="binance">Binance</option>
                  <option value="bybit">Bybit</option>
                </select>
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
                {submitting ? "Submitting..." : "Submit IOC Order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
