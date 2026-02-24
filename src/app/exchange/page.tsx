"use client";

import { useState, useEffect } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";

type ApiKeyRecord = { _id: string; exchange: string; label?: string };

const inputClass =
  "h-10 w-full rounded-lg border border-slate-600 bg-slate-800/50 px-3 text-foreground placeholder:text-slate-500 focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] text-sm";
const labelClass = "text-sm text-slate-400 mb-1 block";

export default function ExchangePage() {
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const [binanceKey, setBinanceKey] = useState("");
  const [binanceSecret, setBinanceSecret] = useState("");
  const [binanceLabel, setBinanceLabel] = useState("");
  const [bybitKey, setBybitKey] = useState("");
  const [bybitSecret, setBybitSecret] = useState("");
  const [bybitPassphrase, setBybitPassphrase] = useState("");
  const [bybitLabel, setBybitLabel] = useState("");

  useEffect(() => {
    api
      .get<{ success: boolean; data: ApiKeyRecord[] }>("/api-keys")
      .then(({ data }) => {
        if (data.success && data.data) setApiKeys(data.data);
      })
      .catch(() => toast.error("Failed to load API keys"))
      .finally(() => setLoading(false));
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
    setSaving(exchange);
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
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="w-full max-w-[100vw] overflow-x-hidden px-4 py-4">
        <h2 className="text-lg font-semibold text-foreground mb-4">Exchange</h2>
        <p className="text-sm text-slate-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[100vw] overflow-x-hidden px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground mb-2">Exchange</h2>
      <p className="text-sm text-slate-400 mb-6">
        Add API keys for Binance and Bybit. Keys are encrypted and stored securely.
      </p>

      <div className="space-y-6">
        {/* Binance */}
        <section className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
          <h3 className="text-base font-medium text-foreground mb-3">Binance</h3>
          {apiKeys.some((k) => k.exchange === "binance") && (
            <p className="text-xs text-[var(--profit)] mb-3">Keys configured</p>
          )}
          <div className="space-y-3">
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
              disabled={saving === "binance"}
              className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--primary)" }}
            >
              {saving === "binance" ? "Saving..." : "Save Binance Keys"}
            </button>
          </div>
        </section>

        {/* Bybit */}
        <section className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
          <h3 className="text-base font-medium text-foreground mb-3">Bybit</h3>
          {apiKeys.some((k) => k.exchange === "bybit") && (
            <p className="text-xs text-[var(--profit)] mb-3">Keys configured</p>
          )}
          <div className="space-y-3">
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
              disabled={saving === "bybit"}
              className="h-10 px-4 rounded-lg font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--primary)" }}
            >
              {saving === "bybit" ? "Saving..." : "Save Bybit Keys"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
