"use client";

import { useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";

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

type WalletData = {
  totalWalletBalance: number;
  availableBalance: number;
  totalPositionInitialMargin: number;
  totalTradeValue?: number;
};

type MetricsData = {
  binanceWallet?: WalletData;
  bybitWallet?: WalletData;
};

type SettingsData = {
  binanceDepositAddress?: string;
  binanceNetwork?: string;
  bybitDepositAddress?: string;
  bybitNetwork?: string;
};

const inputClass =
  "h-10 w-full rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm";
const labelClass = "text-sm text-slate-400 mb-1 block";

const POLL_MS = 2000;

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export default function FundsPage() {
  const [fundLogs, setFundLogs] = useState<FundLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const [metrics, setMetrics] = useState<MetricsData>({});
  const [settings, setSettings] = useState<SettingsData>({});
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [configBinanceAddress, setConfigBinanceAddress] = useState("");
  const [configBinanceNetwork, setConfigBinanceNetwork] = useState("");
  const [configBybitAddress, setConfigBybitAddress] = useState("");
  const [configBybitNetwork, setConfigBybitNetwork] = useState("");

  const [transferFrom, setTransferFrom] = useState<"binance" | "bybit">("binance");
  const [transferAmount, setTransferAmount] = useState("");

  const [type, setType] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDT");
  const [exchange, setExchange] = useState("");
  const [txId, setTxId] = useState("");

  const fetchMetrics = useCallback(() => {
    api
      .get<{ success: boolean; data: MetricsData }>("/dashboard/metrics")
      .then(({ data }) => {
        if (data.success && data.data) {
          setMetrics({
            binanceWallet: data.data.binanceWallet,
            bybitWallet: data.data.bybitWallet,
          });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, POLL_MS);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const fetchSettings = useCallback(() => {
    api
      .get<{ success: boolean; data: SettingsData & Record<string, unknown> }>("/settings")
      .then(({ data }) => {
        if (data.success && data.data) {
          const d = data.data;
          setSettings({
            binanceDepositAddress: d.binanceDepositAddress ?? "",
            binanceNetwork: d.binanceNetwork ?? "",
            bybitDepositAddress: d.bybitDepositAddress ?? "",
            bybitNetwork: d.bybitNetwork ?? "",
          });
          setConfigBinanceAddress(String(d.binanceDepositAddress ?? "").trim());
          setConfigBinanceNetwork(String(d.binanceNetwork ?? "").trim());
          setConfigBybitAddress(String(d.bybitDepositAddress ?? "").trim());
          setConfigBybitNetwork(String(d.bybitNetwork ?? "").trim());
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    api
      .get<{ success: boolean; data: FundLogRecord[] }>("/fund-logs")
      .then(({ data }) => {
        if (data.success && data.data) setFundLogs(data.data);
      })
      .catch(() => toast.error("Failed to load fund history"))
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = parseFloat(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    setSaving(true);
    try {
      await api.post("/fund-logs", {
        type,
        amount: numAmount,
        currency,
        exchange: exchange.trim() || undefined,
        txId: txId.trim() || undefined,
        status: "completed",
      });
      toast.success("Entry saved.");
      setAmount("");
      setTxId("");
      const { data } = await api.get<{ success: boolean; data: FundLogRecord[] }>("/fund-logs");
      if (data.success && data.data) setFundLogs(data.data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Failed to save entry.");
    } finally {
      setSaving(false);
    }
  };

  const binanceWallet = metrics.binanceWallet;
  const bybitWallet = metrics.bybitWallet;

  const binanceActual = binanceWallet?.totalWalletBalance ?? 0;
  const bybitActual = bybitWallet?.totalWalletBalance ?? 0;
  const balanceDiffHalf = Math.abs(binanceActual - bybitActual) / 2;
  const balanceFrom = binanceActual >= bybitActual ? "Binance" : "Bybit";
  const balanceTo = balanceFrom === "Binance" ? "Bybit" : "Binance";

  const handleSaveTransferConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsSaving(true);
    try {
      await api.put("/settings", {
        binanceDepositAddress: configBinanceAddress.trim(),
        binanceNetwork: configBinanceNetwork.trim(),
        bybitDepositAddress: configBybitAddress.trim(),
        bybitNetwork: configBybitNetwork.trim(),
      });
      toast.success("Deposit addresses saved.");
      fetchSettings();
    } catch {
      toast.error("Failed to save settings.");
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(transferAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    const to = transferFrom === "binance" ? "bybit" : "binance";
    setTransferring(true);
    try {
      const { data } = await api.post<{ success?: boolean; message?: string }>("/transfer", {
        from: transferFrom,
        to,
        amount: amt,
      });
      if (data?.success) {
        toast.success(data?.message ?? "Transfer initiated.");
        setTransferAmount("");
        fetchMetrics();
      } else {
        toast.error(data?.message ?? "Transfer failed.");
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? "Transfer failed.");
    } finally {
      setTransferring(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full max-w-[100vw] overflow-x-hidden px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground mb-2 shrink-0">Fund Management</h2>
      <p className="text-sm text-slate-400 mb-4 shrink-0">
        Record manual deposits and withdrawals. History is loaded from the server.
      </p>

      {/* Real-time wallet cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 shrink-0">
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
          <h3 className="text-sm font-medium text-amber-400/90 mb-3">Binance</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between items-baseline">
              <dt className="text-slate-500">Actual Balance</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {binanceWallet ? formatUsd(binanceWallet.totalWalletBalance ?? 0) : "—"}
              </dd>
            </div>
            <div className="flex justify-between items-baseline">
              <dt className="text-slate-500">Available Balance</dt>
              <dd className="font-medium text-emerald-400/90 tabular-nums">
                {binanceWallet
                  ? formatUsd(
                      Number(binanceWallet.totalWalletBalance ?? 0) - Number(binanceWallet.totalTradeValue ?? 0)
                    )
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between items-baseline">
              <dt className="text-slate-500">Total Trade Value</dt>
              <dd className="font-medium text-slate-300 tabular-nums">
                {binanceWallet != null
                  ? formatUsd(Number(binanceWallet.totalTradeValue ?? 0))
                  : "—"}
              </dd>
            </div>
          </dl>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
          <h3 className="text-sm font-medium text-sky-400/90 mb-3">Bybit</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between items-baseline">
              <dt className="text-slate-500">Actual Balance</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {bybitWallet ? formatUsd(bybitWallet.totalWalletBalance ?? 0) : "—"}
              </dd>
            </div>
            <div className="flex justify-between items-baseline">
              <dt className="text-slate-500">Available Balance</dt>
              <dd className="font-medium text-emerald-400/90 tabular-nums">
                {bybitWallet
                  ? formatUsd(
                      Number(bybitWallet.totalWalletBalance ?? 0) - Number(bybitWallet.totalTradeValue ?? 0)
                    )
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between items-baseline">
              <dt className="text-slate-500">Total Trade Value</dt>
              <dd className="font-medium text-slate-300 tabular-nums">
                {bybitWallet != null
                  ? formatUsd(Number(bybitWallet.totalTradeValue ?? 0))
                  : "—"}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Entry form */}
      <section className="mb-8 shrink-0">
        <h3 className="text-base font-medium text-foreground mb-3">New Entry</h3>
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-700 bg-slate-800/30 p-4 space-y-4"
        >
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType("deposit")}
              className={`flex-1 h-10 rounded-lg text-sm font-medium ${
                type === "deposit" ? "text-white" : "text-slate-400 bg-slate-700/50"
              }`}
              style={type === "deposit" ? { backgroundColor: "var(--profit)" } : undefined}
            >
              Deposit
            </button>
            <button
              type="button"
              onClick={() => setType("withdrawal")}
              className={`flex-1 h-10 rounded-lg text-sm font-medium ${
                type === "withdrawal" ? "text-white" : "text-slate-400 bg-slate-700/50"
              }`}
              style={type === "withdrawal" ? { backgroundColor: "var(--loss)" } : undefined}
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
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={inputClass}
              required
            />
          </label>
          <label className="block">
            <span className={labelClass}>Currency</span>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              placeholder="USDT"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Exchange (optional)</span>
            <input
              type="text"
              value={exchange}
              onChange={(e) => setExchange(e.target.value)}
              placeholder="Binance / Bybit"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Transaction ID (optional)</span>
            <input
              type="text"
              value={txId}
              onChange={(e) => setTxId(e.target.value)}
              placeholder="Tx ID"
              className={inputClass}
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="h-10 w-full rounded-lg font-medium text-white disabled:opacity-60"
            style={{ backgroundColor: "var(--primary)" }}
          >
            {saving ? "Saving..." : "Save Entry"}
          </button>
        </form>
      </section>

      {/* Fund Transfer & Balancing */}
      <section className="mb-8 shrink-0 space-y-4">
        <h3 className="text-base font-medium text-foreground">Fund Transfer & Balancing</h3>

        {/* Panel 1: Config */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
          <h4 className="text-sm font-medium text-slate-300 mb-3">Deposit addresses (for withdrawals)</h4>
          <form onSubmit={handleSaveTransferConfig} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Binance deposit address</label>
                <input
                  type="text"
                  value={configBinanceAddress}
                  onChange={(e) => setConfigBinanceAddress(e.target.value)}
                  placeholder="e.g. TXyz..."
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Binance network</label>
                <input
                  type="text"
                  value={configBinanceNetwork}
                  onChange={(e) => setConfigBinanceNetwork(e.target.value)}
                  placeholder="e.g. TRC20, BEP20"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Bybit deposit address</label>
                <input
                  type="text"
                  value={configBybitAddress}
                  onChange={(e) => setConfigBybitAddress(e.target.value)}
                  placeholder="e.g. TXyz..."
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Bybit network</label>
                <input
                  type="text"
                  value={configBybitNetwork}
                  onChange={(e) => setConfigBybitNetwork(e.target.value)}
                  placeholder="e.g. TRC20, BEP20"
                  className={inputClass}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={settingsSaving}
              className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--primary)" }}
            >
              {settingsSaving ? "Saving..." : "Save addresses"}
            </button>
          </form>
        </div>

        {/* Panel 2: Auto balance */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
          <h4 className="text-sm font-medium text-slate-300 mb-2">Auto balance</h4>
          <p className="text-sm text-slate-400">
            {balanceDiffHalf > 0
              ? `To balance both exchanges, transfer ${formatUsd(balanceDiffHalf)} from ${balanceFrom} to ${balanceTo}.`
              : "Balances are even."}
          </p>
        </div>

        {/* Panel 3: Manual transfer */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
          <h4 className="text-sm font-medium text-slate-300 mb-3">Manual transfer</h4>
          <form onSubmit={handleTransfer} className="space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <label className="flex-1 min-w-[120px]">
                <span className={labelClass}>From</span>
                <select
                  value={transferFrom}
                  onChange={(e) => setTransferFrom(e.target.value as "binance" | "bybit")}
                  className={inputClass}
                >
                  <option value="binance">Binance</option>
                  <option value="bybit">Bybit</option>
                </select>
              </label>
              <label className="flex-1 min-w-[120px]">
                <span className={labelClass}>To</span>
                <input
                  type="text"
                  readOnly
                  value={transferFrom === "binance" ? "Bybit" : "Binance"}
                  className={inputClass + " bg-slate-700/50 cursor-not-allowed"}
                />
              </label>
              <label className="flex-1 min-w-[100px]">
                <span className={labelClass}>Amount (USDT)</span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                  placeholder="0"
                  className={inputClass}
                />
              </label>
              <button
                type="submit"
                disabled={transferring}
                className="h-10 px-6 rounded-lg font-medium text-white disabled:opacity-60 shrink-0"
                style={{ backgroundColor: "var(--primary)" }}
              >
                {transferring ? "Transferring..." : "Transfer"}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* History table — scrollable above bottom nav */}
      <section className="flex-1 min-h-0 overflow-y-auto pb-24 flex flex-col">
        <h3 className="text-base font-medium text-foreground mb-3 shrink-0">History</h3>
        {loading ? (
          <Loader size="small" label="Loading..." />
        ) : fundLogs.length === 0 ? (
          <p className="text-sm text-slate-500 py-6">No fund logs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-700 -mx-4 sm:mx-0 shrink-0">
            <table className="w-full text-sm min-w-[320px]">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/50">
                  <th className="text-left py-2.5 px-3 text-slate-400 font-medium">Date</th>
                  <th className="text-left py-2.5 px-3 text-slate-400 font-medium">Type</th>
                  <th className="text-right py-2.5 px-3 text-slate-400 font-medium">Amount</th>
                  <th className="text-left py-2.5 px-3 text-slate-400 font-medium">Currency</th>
                  <th className="text-left py-2.5 px-3 text-slate-400 font-medium">Exchange</th>
                  <th className="text-left py-2.5 px-3 text-slate-400 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {fundLogs.map((log) => (
                  <tr key={log._id} className="border-b border-slate-700/50">
                    <td className="py-2.5 px-3 text-foreground">
                      {new Date(log.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 px-3">
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
                    <td className="py-2.5 px-3 text-right text-foreground font-medium">
                      {log.amount}
                    </td>
                    <td className="py-2.5 px-3 text-slate-400">{log.currency}</td>
                    <td className="py-2.5 px-3 text-slate-400">{log.exchange || "—"}</td>
                    <td className="py-2.5 px-3 text-slate-400">{log.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
