const { binanceManager, bybitManager } = require("./exchanges");
const orderCircuitBreaker = require("./orderCircuitBreaker");

function floorToStepSize(quantity, stepSize) {
  const step = parseFloat(stepSize);
  if (!Number.isFinite(step) || step <= 0) return parseFloat(quantity) || 0;
  const q = parseFloat(quantity);
  const s = String(stepSize);
  const precision = s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
  return parseFloat((Math.floor(q / step) * step).toFixed(precision));
}

async function executeSequentialSmartArbitrage(params) {
  const { symbol, targetQty, bybitSide, binanceSide, binancePositionSide, leverage, slippagePct, markPrice, keys, isExit = false } = params;
  let bybitTotalFilled = 0;
  let binanceTotalFilled = 0;

  const [binFilters, bybFilters] = await Promise.all([
    binanceManager.getSymbolFilters(symbol),
    bybitManager.getSymbolFilters(symbol)
  ]);
  const stepSize = binFilters?.stepSize || bybFilters?.stepSize || 0.001;

  async function executeChunkWithRetries(exchange, side, qty) {
    const floorQty = floorToStepSize(qty, stepSize);
    if (floorQty <= 0) return 0;

    for (let i = 0; i < 5; i++) {
      try {
        let res;
        if (exchange === 'bybit') {
          res = await bybitManager.executeLiquiditySweep(keys.bybit, symbol, side, floorQty, leverage, 1, { slippagePct, reduceOnly: isExit });
        } else {
          res = await binanceManager.executeLiquiditySweep(keys.binance, symbol, side, floorQty, leverage, 1, { positionSide: binancePositionSide, slippagePct, reduceOnly: isExit });
        }
        const filled = res?.totalFilled || 0;
        if (filled > 0) {
          orderCircuitBreaker.recordOrderPlaced();
          return filled;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 20)); // 20ms retry gap
    }
    return 0;
  }

  console.log(`[ExecutionEngine] Starting sequential ${isExit ? "exit" : "entry"} for ${symbol}. Target Qty: ${targetQty}`);

  // 1. PROBE BYBIT
  const minSafeNotional = 6.0;
  let probeQty = Math.max(minSafeNotional / markPrice, stepSize);
  if (isExit && probeQty > targetQty) probeQty = targetQty;
  const bybProbeFilled = await executeChunkWithRetries('bybit', bybitSide, probeQty);

  if (bybProbeFilled <= 0) {
    return { success: false, reason: "Bybit Probe Failed", bybitTotalFilled, binanceTotalFilled };
  }
  bybitTotalFilled += bybProbeFilled;

  // 2. PROBE BINANCE
  const binProbeFilled = await executeChunkWithRetries('binance', binanceSide, bybProbeFilled);
  if (binProbeFilled <= 0) {
    // Reverse Bybit instantly
    const reverseBybitSide = String(bybitSide).toUpperCase() === "BUY" ? "Sell" : "Buy";
    await executeChunkWithRetries('bybit', reverseBybitSide, bybProbeFilled);
    return { success: false, reason: "Binance Probe Failed, Bybit Reversed", bybitTotalFilled: 0, binanceTotalFilled: 0 };
  }
  binanceTotalFilled += binProbeFilled;

  // 3. L1 DYNAMIC CHUNKING LOOP WITH DUST-FOLDING LOCK-STEP
  let remainingQty = targetQty - Math.max(bybitTotalFilled, binanceTotalFilled);
  let emptyLoops = 0;

  while (remainingQty >= stepSize && emptyLoops < 10) {
    // Get next base chunk size from Bybit's L1 book
    const bybBook = bybitManager.getTopOfBook(symbol);
    if (!bybBook) { emptyLoops++; await new Promise(r => setTimeout(r, 100)); continue; }

    const l1Qty = String(bybitSide).toUpperCase() === "BUY" ? (bybBook.topAskQty ?? 0) : (bybBook.topBidQty ?? 0);
    let baseChunkQty = Math.max(Number(l1Qty) * 0.5, stepSize);

    // Force base chunk to be at least $6.0 to safely pass exchange minimum limits
    if (baseChunkQty * markPrice < 6.0) baseChunkQty = Math.max(6.0 / markPrice, stepSize);
    if (baseChunkQty > remainingQty) baseChunkQty = remainingQty;

    // FOLDING LOGIC: If Bybit is behind Binance, add the deficit to Bybit's next chunk
    let bybOrderQty = baseChunkQty;
    if (binanceTotalFilled > bybitTotalFilled) {
      bybOrderQty += (binanceTotalFilled - bybitTotalFilled);
    }

    // 1. Execute Bybit first
    const bybFilled = await executeChunkWithRetries('bybit', bybitSide, bybOrderQty);

    if (bybFilled > 0) {
      bybitTotalFilled += bybFilled;

      // 2. FOLDING LOGIC: Binance must now match Bybit's NEW total.
      // This automatically adds any previous Binance deficit to the new chunk!
      const binanceNeededNow = bybitTotalFilled - binanceTotalFilled;

      if (binanceNeededNow >= stepSize) {
        const binFilled = await executeChunkWithRetries('binance', binanceSide, binanceNeededNow);
        binanceTotalFilled += binFilled;
      }

      remainingQty = targetQty - Math.max(bybitTotalFilled, binanceTotalFilled);
      emptyLoops = 0;
    } else {
      emptyLoops++;
    }
  }

  // 4. FINAL TRUE-UP
  const mismatch = Math.abs(bybitTotalFilled - binanceTotalFilled);
  if (mismatch * markPrice > 6) {
    if (bybitTotalFilled > binanceTotalFilled) {
      binanceTotalFilled += await executeChunkWithRetries('binance', binanceSide, bybitTotalFilled - binanceTotalFilled);
    } else {
      bybitTotalFilled += await executeChunkWithRetries('bybit', bybitSide, binanceTotalFilled - bybitTotalFilled);
    }
  }

  return { success: true, bybitTotalFilled, binanceTotalFilled };
}

module.exports = { executeSequentialSmartArbitrage };
