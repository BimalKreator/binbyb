"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { Loader } from "@/components/Loader";

type ApiKeyRecord = { _id: string; exchange: string; label?: string };
type SettingRecord = {
  _id: string;
  capitalPercent: number;
  maxTrades: number;
  stopLoss: number;
  takeProfit: number;
  autoTrade: boolean;
  userMinSpread?: number;
};
type FundLogRecord = {
  _id: string;
  type: string;
  amount: number;
  currency: string;
  exchange: string;
  txId: string;
  status: string;
  createdAt: string;
};

export default function SettingsPage() {
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [settings, setSettings] = useState<SettingRecord | null>(null);
  const [fundLogs, setFundLogs] = useState<FundLogRecord[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadingFunds, setLoadingFunds] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingFund, setSavingFund] = useState(false);

  // API Keys form state (per exchange)
  const [binanceKey, setBinanceKey] = useState("");
  const [binanceSecret, setBinanceSecret] = useState("");
  const [binanceLabel, setBinanceLabel] = useState("");
  const [bybitKey, setBybitKey] = useState("");
  const [bybitSecret, setBybitSecret] = useState("");
  const [bybitPassphrase, setBybitPassphrase] = useState("");
  const [bybitLabel, setBybitLabel] = useState("");

  // Settings form state
  const [capitalPercent, setCapitalPercent] = useState(10);
  const [maxTrades, setMaxTrades] = useState(5);
  const [stopLoss, setStopLoss] = useState(0);
  const [takeProfit, setTakeProfit] = useState(0);
  const [autoTrade, setAutoTrade] = useState(false);

  // Fund log form
  const [fundType, setFundType] = useState<"deposit" | "withdrawal">("deposit");
  const [fundAmount, setFundAmount] = useState("");
  const [fundCurrency, setFundCurrency] = useState("USDT");
  const [fundExchange, setFundExchange] = useState("");
  const [fundTxId, setFundTxId] = useState("");

  useEffect(() => {
    api.get<{ success: boolean; data: ApiKeyRecord[] }>("/api-keys").then(({ data }) => {
      if (data.success && data.data) setApiKeys(data.data);
    }).catch(() => toast.error("Failed to load API keys")).finally(() => setLoadingKeys(false));
  }, []);

  useEffect(() => {
    api.get<{ success: boolean; data: SettingRecord }>("/settings").then(({ data }) => {
      if (data.success && data.data) {
        const s = data.data;
        setSettings(s);
        setCapitalPercent(s.capitalPercent ?? 10);
        setMaxTrades(s.maxTrades ?? 5);
        setStopLoss(s.stopLoss ?? 0);
        setTakeProfit(s.takeProfit ?? 0);
        setAutoTrade(s.autoTrade ?? false);
      }
    }).catch(() => toast.error("Failed to load settings")).finally(() => setLoadingSettings(false));
  }, []);

  useEffect(() => {
    api.get<{ success: boolean; data: FundLogRecord[] }>("/fund-logs").then(({ data }) => {
      if (data.success && data.data) setFundLogs(data.data);
    }).catch(() => toast.error("Failed to load fund history")).finally(() => setLoadingFunds(false));
  }, []);

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
    setSavingKey(exchange);
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
      setSavingKey(null);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const { data } = await api.put<{ success: boolean; data: SettingRecord }>("/settings", {
        capitalPercent,
        maxTrades,
        stopLoss,
        takeProfit,
        autoTrade,
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

  const submitFundLog = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(fundAmount);
    if (!fundAmount || isNaN(amount) || amount <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setSavingFund(true);
    try {
      await api.post("/fund-logs", {
        type: fundType,
        amount,
        currency: fundCurrency,
        exchange: fundExchange.trim() || undefined,
        txId: fundTxId.trim() || undefined,
        status: "completed",
      });
      toast.success("Fund log added.");
      setFundAmount("");
      setFundTxId("");
      const { data } = await api.get<{ success: boolean; data: FundLogRecord[] }>("/fund-logs");
      if (data.success && data.data) setFundLogs(data.data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Failed to add fund log.");
    } finally {
      setSavingFund(false);
    }
  };

  const inputClass =
    "h-10 w-full rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm";
  const labelClass = "text-sm text-slate-400 mb-1 block";
  const sectionClass = "mb-8";

  return (
    <div className="w-full max-w-[100vw] overflow-x-hidden px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>

      {/* API Keys */}
      <section className={sectionClass}>
        <h3 className="text-base font-medium text-foreground mb-3">Exchange API Keys</h3>
        {loadingKeys ? (
          <Loader size="small" label="Loading..." />
        ) : (
          <div className="space-y-6">
            {/* Binance */}
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <h4 className="text-sm font-medium text-slate-300 mb-3">Binance</h4>
              <div className="grid gap-3">
                <label className="block">
                  <span className={labelClass}>API Key</span>
                  <input
                    type="password"
                    value={binanceKey}
                    onChange={(e) => setBinanceKey(e.target.value)}
                    placeholder="••••••••"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>API Secret</span>
                  <input
                    type="password"
                    value={binanceSecret}
                    onChange={(e) => setBinanceSecret(e.target.value)}
                    placeholder="••••••••"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Label (optional)</span>
                  <input
                    type="text"
                    value={binanceLabel}
                    onChange={(e) => setBinanceLabel(e.target.value)}
                    placeholder="e.g. Main"
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => saveApiKey("binance")}
                  disabled={savingKey === "binance"}
                  className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60"
                  style={{ backgroundColor: "var(--primary)" }}
                >
                  {savingKey === "binance" ? "Saving..." : "Save Binance Keys"}
                </button>
              </div>
            </div>

            {/* Bybit */}
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
              <h4 className="text-sm font-medium text-slate-300 mb-3">Bybit</h4>
              <div className="grid gap-3">
                <label className="block">
                  <span className={labelClass}>API Key</span>
                  <input
                    type="password"
                    value={bybitKey}
                    onChange={(e) => setBybitKey(e.target.value)}
                    placeholder="••••••••"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>API Secret</span>
                  <input
                    type="password"
                    value={bybitSecret}
                    onChange={(e) => setBybitSecret(e.target.value)}
                    placeholder="••••••••"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Passphrase (optional)</span>
                  <input
                    type="password"
                    value={bybitPassphrase}
                    onChange={(e) => setBybitPassphrase(e.target.value)}
                    placeholder="••••••••"
                    className={inputClass}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Label (optional)</span>
                  <input
                    type="text"
                    value={bybitLabel}
                    onChange={(e) => setBybitLabel(e.target.value)}
                    placeholder="e.g. Main"
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => saveApiKey("bybit")}
                  disabled={savingKey === "bybit"}
                  className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60"
                  style={{ backgroundColor: "var(--primary)" }}
                >
                  {savingKey === "bybit" ? "Saving..." : "Save Bybit Keys"}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* App Settings */}
      <section className={sectionClass}>
        <h3 className="text-base font-medium text-foreground mb-3">Trading Settings</h3>
        {loadingSettings ? (
          <Loader size="small" label="Loading..." />
        ) : (
          <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4 space-y-4">
            <label className="block">
              <span className={labelClass}>Capital %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={capitalPercent}
                onChange={(e) => setCapitalPercent(Number(e.target.value))}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Max Trades</span>
              <input
                type="number"
                min={0}
                value={maxTrades}
                onChange={(e) => setMaxTrades(Number(e.target.value))}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Stop Loss (%)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={stopLoss}
                onChange={(e) => setStopLoss(Number(e.target.value))}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Take Profit (%)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={takeProfit}
                onChange={(e) => setTakeProfit(Number(e.target.value))}
                className={inputClass}
              />
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoTrade}
                onChange={(e) => setAutoTrade(e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 text-[var(--primary)] focus:ring-[var(--primary)]"
              />
              <span className="text-sm text-foreground">Auto Trade</span>
            </label>
            <button
              type="button"
              onClick={saveSettings}
              disabled={savingSettings}
              className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--primary)" }}
            >
              {savingSettings ? "Saving..." : "Save Settings"}
            </button>
          </div>
        )}
      </section>

      {/* Fund Management */}
      <section className={sectionClass}>
        <h3 className="text-base font-medium text-foreground mb-3">Fund Management</h3>
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4 mb-4">
          <form onSubmit={submitFundLog} className="space-y-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFundType("deposit")}
                className={`flex-1 h-10 rounded-lg text-sm font-medium ${
                  fundType === "deposit"
                    ? "text-white"
                    : "text-slate-400 bg-slate-700/50"
                }`}
                style={fundType === "deposit" ? { backgroundColor: "var(--profit)" } : undefined}
              >
                Deposit
              </button>
              <button
                type="button"
                onClick={() => setFundType("withdrawal")}
                className={`flex-1 h-10 rounded-lg text-sm font-medium ${
                  fundType === "withdrawal"
                    ? "text-white"
                    : "text-slate-400 bg-slate-700/50"
                }`}
                style={fundType === "withdrawal" ? { backgroundColor: "var(--loss)" } : undefined}
              >
                Withdrawal
              </button>
            </div>
            <label className="block">
              <span className={labelClass}>Amount</span>
              <input
                type="number"
                step="any"
                min="0"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                placeholder="0.00"
                className={inputClass}
                required
              />
            </label>
            <label className="block">
              <span className={labelClass}>Currency</span>
              <input
                type="text"
                value={fundCurrency}
                onChange={(e) => setFundCurrency(e.target.value)}
                placeholder="USDT"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Exchange (optional)</span>
              <input
                type="text"
                value={fundExchange}
                onChange={(e) => setFundExchange(e.target.value)}
                placeholder="Binance / Bybit"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Tx ID (optional)</span>
              <input
                type="text"
                value={fundTxId}
                onChange={(e) => setFundTxId(e.target.value)}
                placeholder="Transaction ID"
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              disabled={savingFund}
              className="h-10 w-full px-4 rounded-lg font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--primary)" }}
            >
              {savingFund ? "Saving..." : "Log " + fundType}
            </button>
          </form>
        </div>

        <h4 className="text-sm font-medium text-slate-300 mb-2">History</h4>
        {loadingFunds ? (
          <Loader size="small" label="Loading..." />
        ) : fundLogs.length === 0 ? (
          <p className="text-sm text-slate-500">No fund logs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/50">
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Date</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Type</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Amount</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Currency</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Exchange</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {fundLogs.map((log) => (
                  <tr key={log._id} className="border-b border-slate-700/50">
                    <td className="py-2 px-3 text-foreground">
                      {new Date(log.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={
                          log.type === "deposit"
                            ? "text-[var(--profit)]"
                            : "text-[var(--loss)]"
                        }
                      >
                        {log.type}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right text-foreground">{log.amount}</td>
                    <td className="py-2 px-3 text-slate-400">{log.currency}</td>
                    <td className="py-2 px-3 text-slate-400">{log.exchange || "—"}</td>
                    <td className="py-2 px-3 text-slate-400">{log.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          className="h-10 px-4 rounded-lg text-sm font-medium text-slate-300 border border-slate-600 hover:bg-slate-700/50"
        >
          Log out
        </button>
      </section>
    </div>
  );
}
