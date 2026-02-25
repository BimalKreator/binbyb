"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { Loader } from "@/components/Loader";

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
export default function SettingsPage() {
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
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
      <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>

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
    </div>
  );
}
