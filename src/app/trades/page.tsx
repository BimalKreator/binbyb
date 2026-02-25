"use client";

import { useState, useEffect } from "react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import { Loader } from "@/components/Loader";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";

type TradeRecord = {
  _id: string;
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  reason: string;
  pnl: number;
  exitTime: string;
  side: string;
  exchange: string;
};

const LIMIT = 20;

function reasonColor(reason: string): string {
  switch (reason) {
    case "Target":
      return "text-emerald-400 bg-emerald-500/15";
    case "SL":
      return "text-red-400 bg-red-500/15";
    case "Orphan":
      return "text-amber-400 bg-amber-500/15";
    case "Manual":
    default:
      return "text-slate-400 bg-slate-500/15";
  }
}

export default function TradesPage() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  useEffect(() => {
    setLoading(true);
    api
      .get<{ success: boolean; data: { total: number; page: number; limit: number; trades: TradeRecord[] } }>(
        "/trades/history",
        { params: { page, limit: LIMIT } }
      )
      .then(({ data }) => {
        if (data.success && data.data) {
          setTrades(data.data.trades || []);
          setTotal(data.data.total ?? 0);
        }
      })
      .catch(() => toast.error("Failed to load trade history"))
      .finally(() => setLoading(false));
  }, [page]);

  return (
    <div className="min-h-[50dvh] w-full px-4 py-4">
      <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 mb-2">
        <Receipt className="w-5 h-5" />
        Trade History
      </h2>
      <p className="text-sm text-slate-400 mb-4">Closed trades with reason and PnL.</p>

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader />
        </div>
      ) : trades.length === 0 ? (
        <p className="text-sm text-slate-500 py-6">No trades yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/50">
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Symbol</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Entry</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Exit</th>
                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Reason</th>
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id} className="border-b border-slate-700/50 hover:bg-slate-800/30">
                    <td className="py-2 px-3 text-foreground">{t.symbol}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{t.entryPrice != null ? Number(t.entryPrice).toFixed(4) : "—"}</td>
                    <td className="py-2 px-3 text-right text-slate-300">{t.exitPrice != null ? Number(t.exitPrice).toFixed(4) : "—"}</td>
                    <td className="py-2 px-3">
                      <span className={`inline-block px-2 py-0.5 rounded ${reasonColor(t.reason || "Manual")}`}>
                        {t.reason || "Manual"}
                      </span>
                    </td>
                    <td className={`py-2 px-3 text-right font-medium ${t.pnl != null && t.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {t.pnl != null ? (t.pnl >= 0 ? `+${Number(t.pnl).toFixed(2)}` : Number(t.pnl).toFixed(2)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-slate-400">
              Page {page} of {totalPages} · {total} total
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-800"
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-800"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
