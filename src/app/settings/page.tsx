"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { Loader } from "@/components/Loader";
import { KeyRound, Sliders } from "lucide-react";

type SettingRecord = {
  _id: string;
  capitalPercent: number;
  leverage?: number;
  maxTrades: number;
  stopLoss: number;
  takeProfit: number;
  useStoploss?: boolean;
  useTarget?: boolean;
  autoTrade: boolean;
  autoTradeEnabled?: boolean;
  autoExitEnabled?: boolean;
  entryTimeMs?: number;
  entrySlippagePct?: number;
  minL2Spread?: number;
  minL2VwapSpread?: number;
  userMinSpread?: number;
  mismatchMinNotionalFilter?: boolean;
  liquidationAutoClose?: boolean;
  liquidationDistancePct?: number;
  cooldownMinutes?: number;
  minFundingConsistency?: number;
  binanceMarginAllowedPct?: number;
  bybitMarginAllowedPct?: number;
  screenerSortBy?: "funding" | "l2spread";
  screenerTradeNotional?: number;
  tradingMode?: "funding" | "l2";
  screenerDirectionBy?: "funding" | "l2";
};

type ApiKeyRecord = { _id: string; exchange: string; label?: string };

export default function SettingsPage() {
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const [settingsTab, setSettingsTab] = useState<"bot" | "exchange">("bot");

  const [settings, setSettings] = useState<SettingRecord | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const [capitalPercent, setCapitalPercent] = useState(10);
  const [leverage, setLeverage] = useState(10);
  const [maxTrades, setMaxTrades] = useState(5);
  const [stopLoss, setStopLoss] = useState(0);
  const [takeProfit, setTakeProfit] = useState(0);
  const [useStoploss, setUseStoploss] = useState(false);
  const [useTarget, setUseTarget] = useState(false);
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [autoExitEnabled, setAutoExitEnabled] = useState(false);
  const [mismatchMinNotionalFilter, setMismatchMinNotionalFilter] = useState(true);
  const [liquidationAutoClose, setLiquidationAutoClose] = useState(false);
  const [liquidationDistancePct, setLiquidationDistancePct] = useState(25);
  const [entryTimeRaw, setEntryTimeRaw] = useState("1");
  const [entryTimeUnit, setEntryTimeUnit] = useState<"ms" | "seconds" | "minutes" | "hours">("ms");
  const [entrySlippagePct, setEntrySlippagePct] = useState(0.1);
  const [cooldownMinutes, setCooldownMinutes] = useState(15);
  const [minL2Spread, setMinL2Spread] = useState("0.15");
  const [minL2VwapSpread, setMinL2VwapSpread] = useState("0.15");
  const [minFundingConsistency, setMinFundingConsistency] = useState(75);
  const [binanceMarginAllowedPct, setBinanceMarginAllowedPct] = useState(50);
  const [bybitMarginAllowedPct, setBybitMarginAllowedPct] = useState(50);
  const [screenerSortBy, setScreenerSortBy] = useState<"funding" | "l2spread">("funding");
  const [screenerTradeNotional, setScreenerTradeNotional] = useState(500);
  const [tradingMode, setTradingMode] = useState<"funding" | "l2">("funding");
  const [screenerDirectionBy, setScreenerDirectionBy] = useState<"funding" | "l2">("funding");

  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [loadingApiKeys, setLoadingApiKeys] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState<string | null>(null);
  const [binanceKey, setBinanceKey] = useState("");
  const [binanceSecret, setBinanceSecret] = useState("");
  const [binanceLabel, setBinanceLabel] = useState("");
  const [bybitKey, setBybitKey] = useState("");
  const [bybitSecret, setBybitSecret] = useState("");
  const [bybitPassphrase, setBybitPassphrase] = useState("");
  const [bybitLabel, setBybitLabel] = useState("");

  useEffect(() => {
    api
      .get<{ success: boolean; data: SettingRecord }>("/settings")
      .then(({ data }) => {
        if (data.success && data.data) {
          const s = data.data;
          setSettings(s);
          setCapitalPercent(s.capitalPercent ?? 10);
          setLeverage(s.leverage ?? 10);
          setMaxTrades(s.maxTrades ?? 5);
          setStopLoss(s.stopLoss ?? 0);
          setTakeProfit(s.takeProfit ?? 0);
          setUseStoploss(s.useStoploss ?? false);
          setUseTarget(s.useTarget ?? false);
          setAutoTradeEnabled(s.autoTradeEnabled ?? s.autoTrade ?? false);
          setAutoExitEnabled(s.autoExitEnabled ?? false);
          setMismatchMinNotionalFilter(s.mismatchMinNotionalFilter ?? true);
          setLiquidationAutoClose(s.liquidationAutoClose ?? false);
          setLiquidationDistancePct(s.liquidationDistancePct ?? 25);
          const ms = s.entryTimeMs ?? 1000;
          const hours = Math.floor(ms / 3600000);
          const minutes = Math.floor(ms / 60000);
          const seconds = Math.floor(ms / 1000);
          if (hours >= 1) {
            setEntryTimeRaw(String(hours));
            setEntryTimeUnit("hours");
          } else if (minutes >= 1) {
            setEntryTimeRaw(String(minutes));
            setEntryTimeUnit("minutes");
          } else if (seconds >= 1) {
            setEntryTimeRaw(String(seconds));
            setEntryTimeUnit("seconds");
          } else {
            setEntryTimeRaw(String(ms));
            setEntryTimeUnit("ms");
          }
          setEntrySlippagePct(s.entrySlippagePct ?? 0.1);
          setCooldownMinutes(s.cooldownMinutes ?? 15);
          setMinL2Spread(String(s.minL2Spread ?? 0.15));
          setMinL2VwapSpread(String(s.minL2VwapSpread ?? 0.15));
          setMinFundingConsistency(s.minFundingConsistency ?? 75);
          setBinanceMarginAllowedPct(s.binanceMarginAllowedPct ?? 50);
          setBybitMarginAllowedPct(s.bybitMarginAllowedPct ?? 50);
          setScreenerSortBy(s.screenerSortBy === "l2spread" ? "l2spread" : "funding");
          setScreenerTradeNotional(s.screenerTradeNotional ?? 500);
          setTradingMode(s.tradingMode === "l2" ? "l2" : "funding");
          setScreenerDirectionBy(s.screenerDirectionBy === "l2" ? "l2" : "funding");
        }
      })
      .catch(() => toast.error("Failed to load settings"))
      .finally(() => setLoadingSettings(false));
  }, []);

  useEffect(() => {
    if (settingsTab !== "exchange") return;
    setLoadingApiKeys(true);
    api
      .get<{ success: boolean; data: ApiKeyRecord[] }>("/api-keys")
      .then(({ data }) => {
        if (data.success && data.data) setApiKeys(data.data);
      })
      .catch(() => toast.error("Failed to load API keys"))
      .finally(() => setLoadingApiKeys(false));
  }, [settingsTab]);

  const saveApiKey = async (exchange: "binance" | "bybit") => {
    const payload =
      exchange === "binance"
        ? { exchange: "binance", apiKey: binanceKey, apiSecret: binanceSecret, label: binanceLabel }
        : {
            exchange: "bybit",
            apiKey: bybitKey,
            apiSecret: bybitSecret,
            passphrase: bybitPassphrase || undefined,
            label: bybitLabel,
          };
    if (!payload.apiKey?.trim() || !payload.apiSecret?.trim()) {
      toast.error("API Key and Secret are required.");
      return;
    }
    setSavingApiKey(exchange);
    try {
      await api.post("/api-keys", payload);
      toast.success(`${exchange === "binance" ? "Binance" : "Bybit"} keys saved.`);
      setApiKeys((prev) => {
        const rest = prev.filter((k) => k.exchange !== exchange);
        return [...rest, { _id: "", exchange, label: payload.label }];
      });
      if (exchange === "binance") {
        setBinanceKey("");
        setBinanceSecret("");
        setBinanceLabel("");
      } else {
        setBybitKey("");
        setBybitSecret("");
        setBybitPassphrase("");
        setBybitLabel("");
      }
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Failed to save API keys.");
    } finally {
      setSavingApiKey(null);
    }
  };

  const entryTimeToMs = (): number => {
    const val = Math.max(0, Number(entryTimeRaw) || 0);
    switch (entryTimeUnit) {
      case "hours":
        return val * 3600000;
      case "minutes":
        return val * 60000;
      case "seconds":
        return val * 1000;
      default:
        return val;
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const { data } = await api.put<{ success: boolean; data: SettingRecord }>("/settings", {
        capitalPercent,
        leverage,
        maxTrades,
        stopLoss,
        takeProfit,
        useStoploss,
        useTarget,
        autoTrade: autoTradeEnabled,
        autoTradeEnabled,
        autoExitEnabled,
        mismatchMinNotionalFilter,
        liquidationAutoClose,
        liquidationDistancePct,
        entryTimeMs: entryTimeToMs(),
        entrySlippagePct,
        cooldownMinutes,
        minL2Spread: Number(minL2Spread),
        minL2VwapSpread: Number(minL2VwapSpread),
        minFundingConsistency,
        binanceMarginAllowedPct,
        bybitMarginAllowedPct,
        screenerSortBy,
        screenerTradeNotional,
        tradingMode,
        screenerDirectionBy,
      });
      if (data.success && data.data) setSettings(data.data);
      toast.success("Settings saved.");
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Failed to save settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  const inputClass =
    "h-10 w-full rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm";
  const labelClass = "text-sm text-slate-400 mb-1 block";
  const sectionClass = "mb-8";

  return (
    <div className="w-full min-w-0 max-w-[100vw] overflow-x-hidden px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground mb-3">Settings</h2>

      <div className="flex gap-1 p-1 rounded-lg bg-slate-800/50 border border-slate-700 mb-4">
        <button
          type="button"
          onClick={() => setSettingsTab("bot")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            settingsTab === "bot"
              ? "bg-[var(--primary)] text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sliders className="w-4 h-4" />
          Bot Settings
        </button>
        <button
          type="button"
          onClick={() => setSettingsTab("exchange")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            settingsTab === "exchange"
              ? "bg-[var(--primary)] text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <KeyRound className="w-4 h-4" />
          Exchange APIs
        </button>
      </div>

      {settingsTab === "exchange" ? (
        <>
          <p className="text-sm text-slate-400 mb-6">
            Add API keys for Binance and Bybit. Keys are encrypted and stored securely.
          </p>
          {loadingApiKeys ? (
            <Loader size="small" label="Loading..." />
          ) : (
            <div className="space-y-6">
              <section className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
                <h3 className="text-base font-medium text-foreground mb-3">Binance</h3>
                {apiKeys.some((k) => k.exchange === "binance") && (
                  <p className="text-xs text-[var(--profit)] mb-3">Keys configured</p>
                )}
                <div className="space-y-3">
                  <label className="block">
                    <span className={labelClass}>API Key</span>
                    <input type="password" value={binanceKey} onChange={(e) => setBinanceKey(e.target.value)} placeholder="••••••••" className={inputClass} />
                  </label>
                  <label className="block">
                    <span className={labelClass}>API Secret</span>
                    <input type="password" value={binanceSecret} onChange={(e) => setBinanceSecret(e.target.value)} placeholder="••••••••" className={inputClass} />
                  </label>
                  <label className="block">
                    <span className={labelClass}>Label (optional)</span>
                    <input type="text" value={binanceLabel} onChange={(e) => setBinanceLabel(e.target.value)} placeholder="e.g. Main" className={inputClass} />
                  </label>
                  <button type="button" onClick={() => saveApiKey("binance")} disabled={savingApiKey === "binance"} className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60" style={{ backgroundColor: "var(--primary)" }}>
                    {savingApiKey === "binance" ? "Saving..." : "Save Binance Keys"}
                  </button>
                </div>
              </section>
              <section className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
                <h3 className="text-base font-medium text-foreground mb-3">Bybit</h3>
                {apiKeys.some((k) => k.exchange === "bybit") && (
                  <p className="text-xs text-[var(--profit)] mb-3">Keys configured</p>
                )}
                <div className="space-y-3">
                  <label className="block">
                    <span className={labelClass}>API Key</span>
                    <input type="password" value={bybitKey} onChange={(e) => setBybitKey(e.target.value)} placeholder="••••••••" className={inputClass} />
                  </label>
                  <label className="block">
                    <span className={labelClass}>API Secret</span>
                    <input type="password" value={bybitSecret} onChange={(e) => setBybitSecret(e.target.value)} placeholder="••••••••" className={inputClass} />
                  </label>
                  <label className="block">
                    <span className={labelClass}>Passphrase (optional)</span>
                    <input type="password" value={bybitPassphrase} onChange={(e) => setBybitPassphrase(e.target.value)} placeholder="••••••••" className={inputClass} />
                  </label>
                  <label className="block">
                    <span className={labelClass}>Label (optional)</span>
                    <input type="text" value={bybitLabel} onChange={(e) => setBybitLabel(e.target.value)} placeholder="e.g. Main" className={inputClass} />
                  </label>
                  <button type="button" onClick={() => saveApiKey("bybit")} disabled={savingApiKey === "bybit"} className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60" style={{ backgroundColor: "var(--primary)" }}>
                    {savingApiKey === "bybit" ? "Saving..." : "Save Bybit Keys"}
                  </button>
                </div>
              </section>
            </div>
          )}
        </>
      ) : (
        <>
      {/* Master toggles - very top */}
      <section className={`${sectionClass} rounded-xl border-2 border-slate-600 bg-slate-800/50 p-5`}>
        <h3 className="text-base font-semibold text-foreground mb-4">Auto Trade & Exit</h3>
        {loadingSettings ? (
          <Loader size="small" label="Loading..." />
        ) : (
          <div className="space-y-5">
            <label className="flex items-center justify-between gap-4 cursor-pointer p-3 rounded-lg bg-slate-700/50 hover:bg-slate-700/70 transition-colors">
              <span className="text-sm font-medium text-foreground">Auto Trade Master Switch</span>
              <div className="relative w-14 h-8 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={autoTradeEnabled}
                  onChange={(e) => setAutoTradeEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors shadow-inner" aria-hidden />
                <div className="absolute left-1 top-1 w-6 h-6 rounded-full bg-white shadow transition-transform peer-checked:translate-x-7" aria-hidden />
              </div>
            </label>
            <label className="flex items-center justify-between gap-4 cursor-pointer p-3 rounded-lg bg-slate-700/50 hover:bg-slate-700/70 transition-colors">
              <span className="text-sm font-medium text-foreground">Auto Exit Master Switch</span>
              <div className="relative w-14 h-8 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={autoExitEnabled}
                  onChange={(e) => setAutoExitEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors shadow-inner" aria-hidden />
                <div className="absolute left-1 top-1 w-6 h-6 rounded-full bg-white shadow transition-transform peer-checked:translate-x-7" aria-hidden />
              </div>
            </label>
            <label className="flex items-center justify-between gap-4 cursor-pointer p-3 rounded-lg bg-slate-700/50 hover:bg-slate-700/70 transition-colors">
              <div>
                <span className="text-sm font-medium text-foreground block">Mismatch Notional Safety ($6)</span>
                <span className="text-xs text-slate-500 mt-0.5 block">
                  When ON, ignores quantity mismatches worth less than $6 to avoid exchange errors. Turn OFF to fix even tiny mismatches.
                </span>
              </div>
              <div className="relative w-14 h-8 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={mismatchMinNotionalFilter}
                  onChange={(e) => setMismatchMinNotionalFilter(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors shadow-inner" aria-hidden />
                <div className="absolute left-1 top-1 w-6 h-6 rounded-full bg-white shadow transition-transform peer-checked:translate-x-7" aria-hidden />
              </div>
            </label>
            <label className="flex items-center justify-between gap-4 cursor-pointer p-3 rounded-lg bg-slate-700/50 hover:bg-slate-700/70 transition-colors">
              <div>
                <span className="text-sm font-medium text-foreground block">Liquidation Auto-Close Protection</span>
                <span className="text-xs text-slate-500 mt-0.5 block">
                  Automatically closes the paired trade if the Mark Price gets within this percentage of the Liquidation Price on either exchange.
                </span>
              </div>
              <div className="relative w-14 h-8 flex-shrink-0">
                <input
                  type="checkbox"
                  checked={liquidationAutoClose}
                  onChange={(e) => setLiquidationAutoClose(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors shadow-inner" aria-hidden />
                <div className="absolute left-1 top-1 w-6 h-6 rounded-full bg-white shadow transition-transform peer-checked:translate-x-7" aria-hidden />
              </div>
            </label>
            {liquidationAutoClose && (
              <label className="block pl-3">
                <span className={labelClass}>Liquidation Distance %</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={liquidationDistancePct}
                  onChange={(e) => setLiquidationDistancePct(Math.max(1, Math.min(100, Number(e.target.value) ?? 25)))}
                  className={inputClass}
                />
                <span className="text-xs text-slate-500 mt-0.5 block">Default 25. Close when mark is within this % of liquidation price.</span>
              </label>
            )}
          </div>
        )}
      </section>

      {/* Trading Settings - synced with Setting model */}
      <section className={sectionClass}>
        <h3 className="text-base font-medium text-foreground mb-3">Trading</h3>
        {loadingSettings ? (
          <Loader size="small" label="Loading..." />
        ) : (
          <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4 space-y-4">
            <label className="block">
              <span className={labelClass}>Capital % per trade</span>
              <input
                type="number"
                min={0}
                max={100}
                value={capitalPercent}
                onChange={(e) => setCapitalPercent(Number(e.target.value) ?? 10)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Leverage</span>
              <input
                type="number"
                min={1}
                max={20}
                value={leverage}
                onChange={(e) => setLeverage(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className={inputClass}
                aria-describedby="leverage-hint"
              />
              <span id="leverage-hint" className="text-xs text-slate-500 mt-0.5 block">1–20x</span>
            </label>
            <label className="block">
              <span className={labelClass}>Max Open Trades</span>
              <span id="max-trades-hint" className="text-xs text-slate-500 block mb-1">
                Maximum number of concurrent active arbitrage pairs
              </span>
              <input
                type="number"
                min={0}
                value={maxTrades}
                onChange={(e) => setMaxTrades(Math.max(0, Number(e.target.value) ?? 0))}
                className={inputClass}
                aria-describedby="max-trades-hint"
              />
            </label>
            <div>
              <span className={labelClass}>SL/TP %</span>
              <div className="grid grid-cols-2 gap-3 mt-1">
                <div className="block">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-slate-500">Stop Loss</span>
                    <label className="inline-flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <div className="relative w-10 h-5 flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={useStoploss}
                          onChange={(e) => setUseStoploss(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors" aria-hidden />
                        <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" aria-hidden />
                      </div>
                      <span className="text-xs font-medium text-slate-400">{useStoploss ? "ON" : "OFF"}</span>
                    </label>
                  </div>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={stopLoss}
                    onChange={(e) => setStopLoss(Number(e.target.value) ?? 0)}
                    className={inputClass}
                  />
                </div>
                <div className="block">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-slate-500">Take Profit</span>
                    <label className="inline-flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <div className="relative w-10 h-5 flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={useTarget}
                          onChange={(e) => setUseTarget(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="absolute inset-0 rounded-full bg-slate-600 peer-checked:bg-emerald-600 transition-colors" aria-hidden />
                        <div className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" aria-hidden />
                      </div>
                      <span className="text-xs font-medium text-slate-400">{useTarget ? "ON" : "OFF"}</span>
                    </label>
                  </div>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(Number(e.target.value) ?? 0)}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
            <label className="block">
              <span className={labelClass}>Entry Time before Funding</span>
              <div className="flex gap-2 mt-1">
                <input
                  type="number"
                  min={0}
                  value={entryTimeRaw}
                  onChange={(e) => setEntryTimeRaw(e.target.value)}
                  className={inputClass}
                  placeholder="1"
                />
                <select
                  value={entryTimeUnit}
                  onChange={(e) => setEntryTimeUnit(e.target.value as "ms" | "seconds" | "minutes" | "hours")}
                  className={`${inputClass} w-auto min-w-[100px]`}
                  aria-label="Entry time unit"
                >
                  <option value="ms">ms</option>
                  <option value="seconds">seconds</option>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
              <span className="text-xs text-slate-500 mt-0.5 block">Time before funding to execute entry (saved as milliseconds)</span>
            </label>
            <label className="block">
              <span className={labelClass}>Entry Slippage Buffer (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={entrySlippagePct}
                onChange={(e) => setEntrySlippagePct(Math.max(0, Math.min(100, Number(e.target.value) ?? 0.1)))}
                className={inputClass}
                placeholder="0.1"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Auto-Trade Cooldown (Minutes)</span>
              <input
                type="number"
                min={0}
                step={1}
                value={cooldownMinutes}
                onChange={(e) => setCooldownMinutes(Math.max(0, Number(e.target.value) ?? 15))}
                className={inputClass}
                placeholder="15"
              />
              <span className="text-xs text-slate-500 mt-0.5 block">
                Time to wait before the bot can re-enter the same token after a trade is closed.
              </span>
            </label>
            <label className="block">
              <span className={labelClass}>Min L2 Spread (%)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={minL2Spread}
                onChange={(e) => setMinL2Spread(e.target.value)}
                className={inputClass}
                placeholder="0.15"
              />
              <span className="text-xs text-slate-500 mt-0.5 block">
                Minimum live orderbook spread % required for bot entry (Phase 1 gate).
              </span>
            </label>
            <label className="block">
              <span className={labelClass}>Minimum L2 VWAP Spread (%)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={minL2VwapSpread}
                onChange={(e) => setMinL2VwapSpread(e.target.value)}
                className={inputClass}
                placeholder="0.15"
              />
              <span className="text-xs text-slate-500 mt-0.5 block">
                Minimum L2 VWAP spread % for screener display and bot entry when using L2 mode.
              </span>
            </label>
            <label className="block">
              <span className={labelClass}>Min Funding Consistency (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={minFundingConsistency}
                onChange={(e) => setMinFundingConsistency(Math.max(0, Math.min(100, Number(e.target.value) ?? 75)))}
                className={inputClass}
                placeholder="75"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Margin Use Allowed% Binance</span>
              <input
                type="number"
                min={0}
                max={100}
                value={binanceMarginAllowedPct}
                onChange={(e) => setBinanceMarginAllowedPct(Math.max(0, Math.min(100, Number(e.target.value) ?? 50)))}
                className={inputClass}
                placeholder="50"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Margin Use Allowed% Bybit</span>
              <input
                type="number"
                min={0}
                max={100}
                value={bybitMarginAllowedPct}
                onChange={(e) => setBybitMarginAllowedPct(Math.max(0, Math.min(100, Number(e.target.value) ?? 50)))}
                className={inputClass}
                placeholder="50"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Bot Trading Mode</span>
              <select
                value={tradingMode}
                onChange={(e) => setTradingMode(e.target.value as "funding" | "l2")}
                className={inputClass}
              >
                <option value="funding">Funding Arbitrage</option>
                <option value="l2">L2 Spread Arbitrage</option>
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Screener Direction Base</span>
              <select
                value={screenerDirectionBy}
                onChange={(e) => setScreenerDirectionBy(e.target.value as "funding" | "l2")}
                className={inputClass}
              >
                <option value="funding">Based on Funding</option>
                <option value="l2">Based on L2 Spread</option>
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Screener Sort By</span>
              <select
                value={screenerSortBy}
                onChange={(e) => setScreenerSortBy(e.target.value as "funding" | "l2spread")}
                className={inputClass}
              >
                <option value="funding">Funding Spread</option>
                <option value="l2spread">L2 VWAP Spread</option>
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Target Trade Value (Notional $)</span>
              <input
                type="number"
                min={1}
                value={screenerTradeNotional}
                onChange={(e) => setScreenerTradeNotional(Math.max(1, Number(e.target.value) || 500))}
                className={inputClass}
                placeholder="500"
              />
            </label>
            <button
              type="button"
              onClick={saveSettings}
              disabled={savingSettings}
              className="min-h-[44px] px-5 py-2.5 rounded-lg font-medium text-white disabled:opacity-60 touch-manipulation"
              style={{ backgroundColor: "var(--primary)" }}
            >
              {savingSettings ? "Saving..." : "Save Settings"}
            </button>
          </div>
        )}
      </section>

      <section className={sectionClass}>
        <button
          type="button"
          onClick={() => {
            logout();
            router.replace("/login");
          }}
          className="min-h-[44px] px-5 py-2.5 rounded-lg text-sm font-medium text-slate-300 border border-slate-600 hover:bg-slate-700/50 touch-manipulation"
        >
          Log out
        </button>
      </section>
        </>
      )}
    </div>
  );
}
