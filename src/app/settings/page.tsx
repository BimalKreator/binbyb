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
  autoTrade: boolean;
  autoTradeEnabled?: boolean;
  autoExitEnabled?: boolean;
  entryTimeMs?: number;
  entrySlippagePct?: number;
  userMinSpread?: number;
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
  const [autoTrade, setAutoTrade] = useState(false);
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [autoExitEnabled, setAutoExitEnabled] = useState(false);
  const [entryTimeMs, setEntryTimeMs] = useState(1000);
  const [entrySlippagePct, setEntrySlippagePct] = useState(2);

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
          setAutoTrade(s.autoTrade ?? false);
          setAutoTradeEnabled(s.autoTradeEnabled ?? false);
          setAutoExitEnabled(s.autoExitEnabled ?? false);
          setEntryTimeMs(s.entryTimeMs ?? 1000);
          setEntrySlippagePct(s.entrySlippagePct ?? 2);
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

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const { data } = await api.put<{ success: boolean; data: SettingRecord }>("/settings", {
        capitalPercent,
        leverage,
        maxTrades,
        stopLoss,
        takeProfit,
        autoTrade,
        autoTradeEnabled,
        autoExitEnabled,
        entryTimeMs,
        entrySlippagePct,
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
                <label className="block">
                  <span className="text-xs text-slate-500 mb-1 block">Stop Loss</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={stopLoss}
                    onChange={(e) => setStopLoss(Number(e.target.value) ?? 0)}
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500 mb-1 block">Take Profit</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(Number(e.target.value) ?? 0)}
                    className={inputClass}
                  />
                </label>
              </div>
            </div>
            <label className="block">
              <span className={labelClass}>Entry Time before Funding (ms)</span>
              <input
                type="number"
                min={0}
                value={entryTimeMs}
                onChange={(e) => setEntryTimeMs(Math.max(0, Number(e.target.value) ?? 1000))}
                className={inputClass}
                placeholder="1000"
              />
              <span className="text-xs text-slate-500 mt-0.5 block">Milliseconds before funding to execute entry</span>
            </label>
            <label className="block">
              <span className={labelClass}>Entry Slippage Buffer (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={entrySlippagePct}
                onChange={(e) => setEntrySlippagePct(Math.max(0, Math.min(100, Number(e.target.value) ?? 2)))}
                className={inputClass}
                placeholder="2"
              />
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoTrade}
                onChange={(e) => setAutoTrade(e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 text-[var(--primary)] focus:ring-[var(--primary)]"
              />
              <span className="text-sm text-foreground">Auto Trade Toggle</span>
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
