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

  // 3. L1 DYNAMIC CHUNKING LOOP WITH STRICT LOCK-STEP SYNC
  let remainingQty = targetQty - bybitTotalFilled;
  let emptyLoops = 0;

  while (remainingQty >= stepSize && emptyLoops < 10) {
    // LOCK-STEP CHECK: Ensure both exchanges are balanced BEFORE taking new L1 chunks
    const mismatch = bybitTotalFilled - binanceTotalFilled;
    const mismatchAbs = Math.abs(mismatch);

    if (mismatchAbs >= stepSize) {
      if (mismatch > 0) {
        // Bybit is ahead. Binance missed a portion of the previous chunk. Catch up Binance first!
        const catchUpFilled = await executeChunkWithRetries('binance', binanceSide, mismatch);
        binanceTotalFilled += catchUpFilled;
        if (catchUpFilled < stepSize) {
          emptyLoops++;
          await new Promise(r => setTimeout(r, 100));
          continue; // Keep trying to catch up! Do NOT advance Bybit.
        }
      } else {
        // Binance is ahead. Bybit needs to catch up.
        const catchUpFilled = await executeChunkWithRetries('bybit', bybitSide, mismatchAbs);
        bybitTotalFilled += catchUpFilled;
        if (catchUpFilled < stepSize) {
          emptyLoops++;
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
      }
      emptyLoops = 0;
      continue; // Re-evaluate balance at the top of the loop
    }

    // Both exchanges are perfectly balanced. Safe to grab the next 50% L1 chunk.
    const bybBook = bybitManager.getTopOfBook(symbol);
    if (!bybBook) { emptyLoops++; await new Promise(r => setTimeout(r, 100)); continue; }

    const l1Qty = String(bybitSide).toUpperCase() === "BUY" ? (bybBook.topAskQty ?? 0) : (bybBook.topBidQty ?? 0);
    let chunkQty = Math.max(Number(l1Qty) * 0.5, stepSize);

    if (chunkQty * markPrice < 5.5) chunkQty = Math.max(5.5 / markPrice, stepSize);
    if (chunkQty > remainingQty) chunkQty = remainingQty;

    const bybFilled = await executeChunkWithRetries('bybit', bybitSide, chunkQty);
    if (bybFilled > 0) {
      bybitTotalFilled += bybFilled;

      // Immediately send the exact same confirmed amount to Binance
      const binFilled = await executeChunkWithRetries('binance', binanceSide, bybFilled);
      binanceTotalFilled += binFilled;

      remainingQty -= bybFilled;
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
