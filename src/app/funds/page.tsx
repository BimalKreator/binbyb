"use client";

import { useState, useEffect } from "react";
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

const inputClass =
  "h-10 w-full rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm";
const labelClass = "text-sm text-slate-400 mb-1 block";

export default function FundsPage() {
  const [fundLogs, setFundLogs] = useState<FundLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDT");
  const [exchange, setExchange] = useState("");
  const [txId, setTxId] = useState("");

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

  return (
    <div className="w-full max-w-[100vw] overflow-x-hidden px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground mb-2">Fund Management</h2>
      <p className="text-sm text-slate-400 mb-6">
        Record manual deposits and withdrawals. History is loaded from the server.
      </p>

      {/* Entry form */}
      <section className="mb-8">
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

      {/* History table */}
      <section>
        <h3 className="text-base font-medium text-foreground mb-3">History</h3>
        {loading ? (
          <Loader size="small" label="Loading..." />
        ) : fundLogs.length === 0 ? (
          <p className="text-sm text-slate-500 py-6">No fund logs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-700 -mx-4 sm:mx-0">
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
