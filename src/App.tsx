import { useState, useRef, useCallback, useEffect } from “react”;

// ─── Constants ────────────────────────────────────────────────────────────────
const DERIV_WS_URL = “wss://ws.binaryws.com/websockets/v3?app_id=1089”;

const SYMBOLS = [
{ value: “R_10”,  label: “Volatility 10”,  tag: “V10”  },
{ value: “R_25”,  label: “Volatility 25”,  tag: “V25”  },
{ value: “R_50”,  label: “Volatility 50”,  tag: “V50”  },
{ value: “R_75”,  label: “Volatility 75”,  tag: “V75”  },
{ value: “R_100”, label: “Volatility 100”, tag: “V100” },
];

const STRATEGIES = [
{ value: “HYBRID”, label: “Hybrid (RSI + BB + EMA)”, desc: “All three indicators vote. Requires 2 of 3 to agree. Weighted scoring.” },
{ value: “RSI”,    label: “RSI Only”,                desc: “Buy when RSI < 30 (oversold), Sell when RSI > 70 (overbought).” },
{ value: “EMA”,    label: “EMA 9/21 Only”,           desc: “Buy when EMA9 crosses above EMA21, Sell on cross below.” },
{ value: “BB”,     label: “Bollinger Band Only”,     desc: “Buy at lower band touch, Sell at upper band touch.” },
{ value: “MACD”,   label: “MACD Only”,               desc: “Buy on MACD crossing above signal line, Sell on cross below.” },
];

const DURATIONS = [
{ value: 1,  label: “1 min”  },
{ value: 2,  label: “2 min”  },
{ value: 5,  label: “5 min”  },
{ value: 10, label: “10 min” },
{ value: 15, label: “15 min” },
];

// ─── Indicator Math ───────────────────────────────────────────────────────────
const calcEMA = (prices, period) => {
if (prices.length < period) return null;
const k = 2 / (period + 1);
let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
return ema;
};

// FIX #7: was `if (!rsi)` which incorrectly returns null for RSI === 0.
// RSI is now checked with an explicit null comparison throughout.
const calcRSI = (prices, period = 14) => {
if (prices.length < period + 1) return null;
const changes = prices.slice(-period - 1).map((p, i, a) => i === 0 ? 0 : p - a[i - 1]).slice(1);
const avgGain = changes.map(c => c > 0 ? c : 0).reduce((a, b) => a + b, 0) / period;
const avgLoss = changes.map(c => c < 0 ? -c : 0).reduce((a, b) => a + b, 0) / period;
if (avgLoss === 0) return 100;
return 100 - 100 / (1 + avgGain / avgLoss);
};

const calcBB = (prices, period = 20) => {
if (prices.length < period) return null;
const slice = prices.slice(-period);
const mean = slice.reduce((a, b) => a + b, 0) / period;
const std = Math.sqrt(slice.map(p => (p - mean) ** 2).reduce((a, b) => a + b, 0) / period);
return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
};

const calcMACD = (prices) => {
if (prices.length < 26) return null;
const ema12 = calcEMA(prices, 12);
const ema26 = calcEMA(prices, 26);
if (ema12 === null || ema26 === null) return null;
const macdLine = ema12 - ema26;
const last9 = prices.slice(-9).map((_, i) => {
const sub = prices.slice(0, prices.length - 9 + i + 1);
const a = calcEMA(sub, 12);
const b = calcEMA(sub, 26);
return (a !== null && b !== null) ? a - b : 0;
});
const signalLine = last9.reduce((a, b) => a + b, 0) / 9;
return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
};

// ─── Hybrid Signal Engine ─────────────────────────────────────────────────────
// Best complementary trio for synthetic indices:
//   RSI (35%) — measures momentum exhaustion
//   BB  (35%) — measures price position relative to recent range
//   EMA (30%) — confirms trend direction
// Fires only when at least 2 of 3 agree.
// Strength = weighted average of agreeing indicator scores + 8% bonus if all 3 agree.
const computeHybrid = (prices) => {
if (prices.length < 35) return null;
const price = prices[prices.length - 1];

const rsi  = calcRSI(prices);
const bb   = calcBB(prices);
const ema9 = calcEMA(prices, 9);
const ema21 = calcEMA(prices, 21);

if (rsi === null || bb === null || ema9 === null || ema21 === null) return null;

// ── RSI vote ──
// FIX #6: removed unused pEma9/pEma21 which were computed but never referenced.
let rsiVote = 0, rsiScore = 0, rsiLabel = “”;
if (rsi < 35) {
rsiVote = 1;
rsiScore = Math.min(100, 60 + (35 - rsi) * 2.5);
rsiLabel = `${rsi.toFixed(1)} — oversold`;
} else if (rsi > 65) {
rsiVote = -1;
rsiScore = Math.min(100, 60 + (rsi - 65) * 2.5);
rsiLabel = `${rsi.toFixed(1)} — overbought`;
} else {
rsiScore = Math.max(20, 50 - Math.abs(rsi - 50) * 1.5);
rsiLabel = `${rsi.toFixed(1)} — neutral`;
}

// ── BB vote (bbPos: 0 = at lower band, 1 = at upper band) ──
const bbRange = bb.upper - bb.lower;
const bbPos   = bbRange > 0 ? (price - bb.lower) / bbRange : 0.5;
let bbVote = 0, bbScore = 0, bbLabel = “”;
if (bbPos < 0.2) {
bbVote = 1;
bbScore = Math.min(100, 60 + (0.2 - bbPos) * 200);
bbLabel = `${(bbPos * 100).toFixed(0)}% — near lower`;
} else if (bbPos > 0.8) {
bbVote = -1;
bbScore = Math.min(100, 60 + (bbPos - 0.8) * 200);
bbLabel = `${(bbPos * 100).toFixed(0)}% — near upper`;
} else {
bbScore = 40;
bbLabel = `${(bbPos * 100).toFixed(0)}% — mid-band`;
}

// ── EMA vote ──
const separation = Math.abs(ema9 - ema21) / (ema21 * 0.001 + 0.0001);
const emaScore   = Math.min(100, 55 + Math.min(separation * 20, 100) * 0.35);
const emaVote    = ema9 > ema21 ? 1 : -1;
const emaLabel   = ema9 > ema21 ? “EMA9 above EMA21” : “EMA9 below EMA21”;

// ── Tally votes ──
const callVotes = [rsiVote, bbVote, emaVote].filter(v => v === 1).length;
const putVotes  = [rsiVote, bbVote, emaVote].filter(v => v === -1).length;
if (callVotes < 2 && putVotes < 2) return null;

const direction  = callVotes >= putVotes ? “CALL” : “PUT”;
const dirMult    = direction === “CALL” ? 1 : -1;
const allAgree   = callVotes === 3 || putVotes === 3;

// ── Weighted strength (FIX #10: renamed ws→weightedSum to avoid confusion with WebSocket ref) ──
const W = { rsi: 0.35, bb: 0.35, ema: 0.30 };
let weightedSum = 0, totalWeight = 0;

const addVote = (vote, score, w) => {
if (vote === dirMult)   { weightedSum += score * w; totalWeight += w; }
else if (vote === 0)    { weightedSum += score * w * 0.3; totalWeight += w * 0.3; }
// Opposing votes contribute nothing to weighted strength
};
addVote(rsiVote, rsiScore, W.rsi);
addVote(bbVote,  bbScore,  W.bb);
if (emaVote === dirMult)  { weightedSum += emaScore * W.ema; totalWeight += W.ema; }

const rawStrength = totalWeight > 0 ? weightedSum / totalWeight : 0;
const strength    = Math.min(100, Math.round(rawStrength + (allAgree ? 8 : 0)));
if (strength < 52) return null;

return {
direction, strength, allAgree,
summary: `${allAgree ? "3/3" : "2/3"} indicators agree`,
components: {
rsi: { vote: rsiVote,  score: Math.round(rsiScore),  label: rsiLabel,  agrees: rsiVote  === dirMult },
bb:  { vote: bbVote,   score: Math.round(bbScore),   label: bbLabel,   agrees: bbVote   === dirMult },
ema: { vote: emaVote,  score: Math.round(emaScore),  label: emaLabel,  agrees: emaVote  === dirMult },
},
};
};

const computeSingle = (strategy, prices, prev) => {
if (prices.length < 30) return null;

if (strategy === “RSI”) {
const rsi = calcRSI(prices);
// FIX #7: explicit null check — `!rsi` would wrongly reject rsi === 0
if (rsi === null) return null;
if (rsi < 30) return { direction: “CALL”, strength: Math.min(100, Math.round(60 + (30 - rsi) * 3)), summary: `RSI ${rsi.toFixed(1)} — oversold`,    components: null };
if (rsi > 70) return { direction: “PUT”,  strength: Math.min(100, Math.round(60 + (rsi - 70) * 3)), summary: `RSI ${rsi.toFixed(1)} — overbought`, components: null };
}

if (strategy === “EMA”) {
const e9  = calcEMA(prices, 9),  e21  = calcEMA(prices, 21);
const pe9 = calcEMA(prev, 9),    pe21 = calcEMA(prev, 21);
if (e9 === null || e21 === null || pe9 === null || pe21 === null) return null;
if (pe9 < pe21 && e9 > e21) return { direction: “CALL”, strength: 74, summary: “EMA9 crossed above EMA21”, components: null };
if (pe9 > pe21 && e9 < e21) return { direction: “PUT”,  strength: 74, summary: “EMA9 crossed below EMA21”, components: null };
}

if (strategy === “BB”) {
// FIX #9 (partial): price is only needed here, so scoped to this block
const price = prices[prices.length - 1];
const bb = calcBB(prices);
if (!bb) return null;
if (price <= bb.lower) return { direction: “CALL”, strength: 70, summary: “Price at lower Bollinger Band”, components: null };
if (price >= bb.upper) return { direction: “PUT”,  strength: 70, summary: “Price at upper Bollinger Band”, components: null };
}

if (strategy === “MACD”) {
const m  = calcMACD(prices);
const pm = calcMACD(prev);
if (!m || !pm) return null;
if (pm.macd < pm.signal && m.macd > m.signal) return { direction: “CALL”, strength: 72, summary: “MACD crossed above signal”, components: null };
if (pm.macd > pm.signal && m.macd < m.signal) return { direction: “PUT”,  strength: 72, summary: “MACD crossed below signal”, components: null };
}

return null;
};

// FIX #6: computeHybrid no longer needs `prev` — removed that parameter
const getSignal = (strategy, prices, prev) =>
strategy === “HYBRID” ? computeHybrid(prices) : computeSingle(strategy, prices, prev);

// ─── Sparkline ────────────────────────────────────────────────────────────────
const Sparkline = ({ data, color = “#00ff88”, width = 130, height = 38 }) => {
if (!data || data.length < 2) return <svg width={width} height={height} />;
const min = Math.min(…data), max = Math.max(…data), range = max - min || 1;
const pts = data.map((v, i) =>
`${(i / (data.length - 1)) * width},${height - ((v - min) / range) * height}`
).join(” “);
return (
<svg width={width} height={height} style={{ overflow: “visible” }}>
<polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
</svg>
);
};

// ─── Circular Strength Gauge ──────────────────────────────────────────────────
const StrengthGauge = ({ value, size = 70 }) => {
const r  = size / 2 - 7;
const cx = size / 2, cy = size / 2;
const toRad = deg => (deg * Math.PI) / 180;
const arcPath = (startDeg, endDeg) => {
const sx = cx + r * Math.cos(toRad(startDeg));
const sy = cy + r * Math.sin(toRad(startDeg));
const ex = cx + r * Math.cos(toRad(endDeg));
const ey = cy + r * Math.sin(toRad(endDeg));
const large = endDeg - startDeg > 180 ? 1 : 0;
return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
};
const color  = value >= 80 ? “#00ff88” : value >= 65 ? “#ffaa00” : “#ff3d5f”;
const endDeg = 135 + (value / 100) * 270;
return (
<svg width={size} height={size}>
<path d={arcPath(135, 404.9)} fill=“none” stroke=”#162e22” strokeWidth=“6” strokeLinecap=“round” />
<path d={arcPath(135, Math.min(endDeg, 404.8))} fill=“none” stroke={color} strokeWidth=“6”
strokeLinecap=“round” style={{ filter: `drop-shadow(0 0 5px ${color}90)` }} />
<text x={cx} y={cy + 5} textAnchor=“middle” fill={color} fontSize=“13”
fontFamily=”‘Syne’,sans-serif” fontWeight=“800”>{value}%</text>
</svg>
);
};

// ─── Indicator Pill ───────────────────────────────────────────────────────────
const Pill = ({ label, score, agrees, vote }) => {
const color  = agrees ? “#00ff88” : vote === 0 ? “#5a9e78” : “#ff3d5f”;
const bg     = agrees ? “rgba(0,255,136,.09)”   : vote === 0 ? “rgba(90,158,120,.06)”  : “rgba(255,61,95,.09)”;
const border = agrees ? “rgba(0,255,136,.3)”    : vote === 0 ? “rgba(90,158,120,.2)”   : “rgba(255,61,95,.3)”;
const arrow  = vote === 1 ? “↑” : vote === -1 ? “↓” : “–”;
return (
<div style={{ flex: 1, background: bg, border: `1px solid ${border}`, borderRadius: 4,
padding: “7px 9px”, display: “flex”, flexDirection: “column”, gap: 4 }}>
<div style={{ display: “flex”, justifyContent: “space-between” }}>
<span style={{ fontSize: 8, color: “#5a9e78”, letterSpacing: 1.5, textTransform: “uppercase” }}>{label}</span>
<span style={{ fontSize: 13, color, fontWeight: 700, lineHeight: 1 }}>{arrow}</span>
</div>
<div style={{ fontSize: 12, color, fontWeight: 700 }}>{score}%</div>
<div style={{ height: 3, background: “#162e22”, borderRadius: 2 }}>
<div style={{ height: “100%”, width: `${score}%`, background: color, borderRadius: 2, transition: “width .4s” }} />
</div>
</div>
);
};

// ─── Main Component ───────────────────────────────────────────────────────────
export default function DerivBot() {
// ── Auth & connection state ──
const [tokenInput, setTokenInput]   = useState(””);
const [connected, setConnected]     = useState(false);
const [authorized, setAuthorized]   = useState(false);
const [accountInfo, setAccountInfo] = useState(null);
const [balance, setBalance]         = useState(null);
const [wsStatus, setWsStatus]       = useState(“disconnected”);

// ── Bot configuration ──
const [symbol, setSymbol]               = useState(“R_50”);
const [strategy, setStrategy]           = useState(“HYBRID”);
const [stake, setStake]                 = useState(“1”);
const [duration, setDuration]           = useState(5);
const [maxDailyLoss, setMaxDailyLoss]   = useState(“10”);
const [maxTrades, setMaxTrades]         = useState(“20”);
const [minStrength, setMinStrength]     = useState(“65”);
const [martingale, setMartingale]       = useState(false);
const [martMul, setMartMul]             = useState(“2”);
const [execMode, setExecMode]           = useState(“auto”); // “auto” | “manual”

// ── Bot runtime state ──
const [botRunning, setBotRunning]           = useState(false);
const [currentPrice, setCurrentPrice]       = useState(null);
const [priceHistory, setPriceHistory]       = useState([]);
const [liveSignal, setLiveSignal]           = useState(null);
const [pendingSignal, setPendingSignal]     = useState(null);
const [signals, setSignals]                 = useState([]);
const [trades, setTrades]                   = useState([]);
const [openContracts, setOpenContracts]     = useState([]);
const [dailyPnL, setDailyPnL]               = useState(0);
const [todayTrades, setTodayTrades]         = useState(0);
const [consecLosses, setConsecLosses]       = useState(0);
const [activeTab, setActiveTab]             = useState(“signal”);
const [logs, setLogs]                       = useState([]);

// ── Refs for values needed inside callbacks without stale closures ──
// FIX #1 & #2: Instead of listing fast-changing state in useCallback dep arrays
// (which causes handleMsg/evalSignal to be recreated constantly), all mutable
// values are mirrored into refs. Callbacks read from refs, never from state directly.
const socketRef       = useRef(null);   // renamed from `ws` to avoid name clash with local variables
const pricesRef       = useRef([]);
const prevRef         = useRef([]);
const runningRef      = useRef(false);
const pnlRef          = useRef(0);
const tradeCountRef   = useRef(0);      // renamed from tradesRef for clarity
const consecLossRef   = useRef(0);
const initStakeRef    = useRef(1);      // FIX #2: holds the user’s configured stake for resetting after wins
const currentStakeRef = useRef(1);      // tracks live stake (may be inflated by Martingale)
const execModeRef     = useRef(“auto”);
const symbolRef       = useRef(“R_50”);
const strategyRef     = useRef(“HYBRID”);
const durationRef     = useRef(5);
const minStrRef       = useRef(65);
const accountInfoRef  = useRef(null);
const martingaleRef   = useRef(false);
const martMulRef      = useRef(2);
const maxLossRef      = useRef(10);
const maxTradesRef    = useRef(20);
const lastSignalRef   = useRef(0);
const tickCountRef    = useRef(0);      // FIX #9: throttle priceHistory state updates

// FIX #4: store trade direction at buy-time, keyed by contract_id
const pendingDirections = useRef({});

// FIX #1: store handleMsg and evalSignal in refs so the WebSocket onmessage
// always calls the latest version without needing to re-register the handler.
const handleMsgRef  = useRef(null);
const evalSignalRef = useRef(null);

// Keep config refs in sync with state
useEffect(() => { execModeRef.current      = execMode;                  }, [execMode]);
useEffect(() => { symbolRef.current        = symbol;                    }, [symbol]);
useEffect(() => { strategyRef.current      = strategy;                  }, [strategy]);
useEffect(() => { durationRef.current      = duration;                  }, [duration]);
useEffect(() => { minStrRef.current        = parseFloat(minStrength);   }, [minStrength]);
useEffect(() => { accountInfoRef.current   = accountInfo;               }, [accountInfo]);
useEffect(() => { martingaleRef.current    = martingale;                }, [martingale]);
useEffect(() => { martMulRef.current       = parseFloat(martMul);       }, [martMul]);
useEffect(() => { maxLossRef.current       = parseFloat(maxDailyLoss);  }, [maxDailyLoss]);
useEffect(() => { maxTradesRef.current     = parseInt(maxTrades, 10);   }, [maxTrades]);
useEffect(() => { initStakeRef.current     = parseFloat(stake);         }, [stake]); // FIX #2

const addLog = useCallback((msg, type = “info”) => {
const time = new Date().toLocaleTimeString(“en-GB”);
setLogs(prev => [{ time, msg, type, id: Date.now() + Math.random() }, …prev].slice(0, 100));
}, []);

// ── Place a trade ──
const placeTrade = useCallback((signal) => {
if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
addLog(“WebSocket not ready”, “error”);
return;
}
const tradeStake = currentStakeRef.current;
const payload = {
buy: 1,
price: tradeStake,
parameters: {
amount: tradeStake,
basis: “stake”,
contract_type: signal.direction,
currency: accountInfoRef.current?.currency || “USD”,
duration: durationRef.current,
duration_unit: “m”,
symbol: symbolRef.current,
},
};
// FIX #4: store direction now so onmessage can read it without parsing longcode
pendingDirections.current[”__next”] = signal.direction;
socketRef.current.send(JSON.stringify(payload));
setPendingSignal(null);
addLog(`Placing ${signal.direction} · stake ${tradeStake.toFixed(2)} · strength ${signal.strength}%`, “success”);
}, [addLog]);

const dismissSignal = useCallback(() => {
addLog(“Signal dismissed”, “warning”);
setPendingSignal(null);
}, [addLog]);

// ── Main message handler ──
// FIX #1: defined as a plain function (not useCallback) and stored in handleMsgRef.
// The WebSocket’s onmessage calls handleMsgRef.current(), so it always uses the
// latest closure without the socket needing to be re-registered.
const handleMsg = (data) => {
if (data.error) {
addLog(`Deriv error: ${data.error.message}`, “error”);
return;
}

```
if (data.msg_type === "authorize") {
  setAuthorized(true);
  setAccountInfo(data.authorize);
  accountInfoRef.current = data.authorize;
  setBalance(data.authorize.balance);
  addLog(`Authorized — ${data.authorize.loginid} · ${data.authorize.currency} ${data.authorize.balance}`, "success");
  socketRef.current?.send(JSON.stringify({ balance: 1, subscribe: 1 }));
}

if (data.msg_type === "balance") {
  setBalance(data.balance.balance);
}

if (data.msg_type === "tick") {
  const price = parseFloat(data.tick.quote);
  setCurrentPrice(price);
  prevRef.current = [...pricesRef.current];
  pricesRef.current = [...pricesRef.current, price].slice(-300);

  // FIX #9: only update priceHistory state every 5 ticks to avoid re-rendering
  // the sparkline 60+ times per minute. Signal evaluation still runs every tick.
  tickCountRef.current += 1;
  if (tickCountRef.current % 5 === 0) {
    setPriceHistory([...pricesRef.current]);
  }

  if (runningRef.current && pricesRef.current.length >= 35) {
    evalSignalRef.current(price);
  }
}

if (data.msg_type === "buy") {
  const contractId = data.buy.contract_id;
  // FIX #4: read direction from our own map, not from the longcode string
  const direction = pendingDirections.current["__next"] || "CALL";
  delete pendingDirections.current["__next"];
  pendingDirections.current[contractId] = direction;

  // FIX #3: increment trade counter here (confirmed by Deriv) not in placeTrade
  tradeCountRef.current += 1;
  setTodayTrades(prev => prev + 1);

  addLog(`Contract #${contractId} opened · stake ${data.buy.buy_price}`, "success");
  setOpenContracts(prev => [...prev, {
    id: contractId,
    buyPrice: data.buy.buy_price,
    openTime: new Date().toLocaleTimeString(),
    symbol: symbolRef.current,
    direction,
  }]);
  socketRef.current?.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  }));
}

if (data.msg_type === "proposal_open_contract") {
  const contract = data.proposal_open_contract;
  if (!contract.is_sold) return;

  const contractId = contract.contract_id;
  const profit = parseFloat(contract.profit);
  // FIX #5: unsubscribe from this contract's feed once it's settled
  socketRef.current?.send(JSON.stringify({ forget: contract.id }));
  delete pendingDirections.current[contractId];

  pnlRef.current += profit;
  setDailyPnL(prev => prev + profit);
  setOpenContracts(prev => prev.filter(c => c.id !== contractId));

  if (profit > 0) {
    consecLossRef.current = 0;
    setConsecLosses(0);
    // FIX #2: reset to initStakeRef (user's configured value) not a stale `stake` closure
    currentStakeRef.current = initStakeRef.current;
    addLog(`✓ WON +${profit.toFixed(2)}`, "success");
  } else {
    consecLossRef.current += 1;
    setConsecLosses(consecLossRef.current);
    if (martingaleRef.current) {
      currentStakeRef.current = currentStakeRef.current * martMulRef.current;
      addLog(`✗ LOST ${profit.toFixed(2)} · Martingale → stake ${currentStakeRef.current.toFixed(2)}`, "warning");
    } else {
      addLog(`✗ LOST ${profit.toFixed(2)}`, "error");
    }
  }

  // FIX #4: direction from our map, not from contract_type string parsing
  const dir = pendingDirections.current[contractId] ||
    (contract.contract_type?.includes("CALL") ? "CALL" : "PUT");

  setTrades(prev => [{
    id: contractId,
    time: new Date().toLocaleTimeString(),
    symbol: symbolRef.current,
    direction: dir,
    stake: parseFloat(contract.buy_price),
    profit,
    won: profit > 0,
    payout: parseFloat(contract.sell_price || 0),
  }, ...prev].slice(0, 50));
}
```

};

// ── Signal evaluation ──
// FIX #1: also stored in a ref so handleMsg always calls the latest version.
const evalSignal = (price) => {
// Daily loss guard
if (pnlRef.current <= -maxLossRef.current) {
addLog(“⚠ Daily loss limit hit — stopping bot”, “warning”);
setBotRunning(false);
runningRef.current = false;
return;
}
// Max trades guard
if (tradeCountRef.current >= maxTradesRef.current) {
addLog(“⚠ Max daily trades reached — stopping bot”, “warning”);
setBotRunning(false);
runningRef.current = false;
return;
}
// Consecutive loss cooldown
if (consecLossRef.current >= 5) {
addLog(“⚠ 5 consecutive losses — cooling down”, “warning”);
consecLossRef.current = 0;
setConsecLosses(0);
return;
}

```
const prices = pricesRef.current;
const prev   = prevRef.current.length > 0 ? prevRef.current : prices.slice(0, -1);
const signal = getSignal(strategyRef.current, prices, prev);

setLiveSignal(signal);
if (!signal || signal.strength < minStrRef.current) return;

// Debounce: don't fire a new tradeable signal within 12 seconds of the last one
const now = Date.now();
if (now - lastSignalRef.current < 12000) return;
lastSignalRef.current = now;

const entry = {
  id: now,
  time: new Date().toLocaleTimeString(),
  ...signal,
  price: price.toFixed(5),
  acted: execModeRef.current === "auto",
};
setSignals(prev => [entry, ...prev].slice(0, 30));
addLog(`Signal: ${signal.direction} · ${signal.strength}% · ${signal.summary}`, "signal");

if (execModeRef.current === "auto") {
  placeTrade(signal);
} else {
  setPendingSignal(entry);
}
```

};

// FIX #1: keep the refs pointing to the latest function versions on every render
handleMsgRef.current  = handleMsg;
evalSignalRef.current = evalSignal;

// ── WebSocket connect ──
const connect = useCallback(() => {
if (socketRef.current) socketRef.current.close();
setWsStatus(“connecting”);
addLog(“Connecting to Deriv…”, “info”);

```
const socket = new WebSocket(DERIV_WS_URL);
socketRef.current = socket;

socket.onopen  = () => { setConnected(true);  setWsStatus("connected");    addLog("Connected", "success"); };
socket.onclose = () => {
  setConnected(false); setAuthorized(false); setWsStatus("disconnected");
  setBotRunning(false); runningRef.current = false;
  addLog("Disconnected", "warning");
};
socket.onerror = () => { setWsStatus("error"); addLog("Connection error", "error"); };
// FIX #1: delegate to ref so the handler is always fresh
socket.onmessage = (e) => handleMsgRef.current(JSON.parse(e.data));
```

}, [addLog]);

const authorize = () => {
if (!tokenInput.trim()) { addLog(“Enter a token first”, “error”); return; }
socketRef.current?.send(JSON.stringify({ authorize: tokenInput }));
addLog(“Authorizing…”, “info”);
};

const startBot = () => {
if (!authorized) { addLog(“Authorize first”, “error”); return; }
pricesRef.current     = [];
prevRef.current       = [];
tickCountRef.current  = 0;
currentStakeRef.current = initStakeRef.current;
setBotRunning(true);
runningRef.current = true;
socketRef.current?.send(JSON.stringify({ forget_all: “ticks” }));
socketRef.current?.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
const modeLabel = execMode === “auto” ? “Auto” : “Manual”;
addLog(`Bot started · ${STRATEGIES.find(s => s.value === strategy)?.label} · ${symbol} · ${modeLabel}`, “success”);
};

const stopBot = () => {
setBotRunning(false);
runningRef.current = false;
socketRef.current?.send(JSON.stringify({ forget_all: “ticks” }));
setPendingSignal(null);
setLiveSignal(null);
addLog(“Bot stopped”, “warning”);
};

const resetDay = () => {
pnlRef.current          = 0;
tradeCountRef.current   = 0;
consecLossRef.current   = 0;
currentStakeRef.current = initStakeRef.current;
setDailyPnL(0);
setTodayTrades(0);
setConsecLosses(0);
addLog(“Daily stats reset”, “info”);
};

// ── Derived display values ──
const symInfo    = SYMBOLS.find(s => s.value === symbol);
const winRate    = trades.length > 0
? ((trades.filter(t => t.won).length / trades.length) * 100).toFixed(1)
: null;
const totalPnL   = trades.reduce((a, t) => a + t.profit, 0);
const lossRatio  = parseFloat(maxDailyLoss) > 0
? Math.min(100, (Math.abs(Math.min(0, dailyPnL)) / parseFloat(maxDailyLoss)) * 100)
: 0;
const tradeRatio = parseInt(maxTrades, 10) > 0
? Math.min(100, (todayTrades / parseInt(maxTrades, 10)) * 100)
: 0;
const riskColor  = lossRatio > 75 ? “#ff3d5f” : lossRatio > 50 ? “#ffaa00” : “#00ff88”;
const strColor   = (s) => s >= 80 ? “#00ff88” : s >= 65 ? “#ffaa00” : “#ff3d5f”;

// ── Styles ────────────────────────────────────────────────────────────────
const CSS = `@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap'); *,*::before,*::after{box-sizing:border-box;margin:0;padding:0} :root{ --bg:#020c08;--bg2:#050f0a;--bg3:#0a1910; --bd:#142a1c;--bd2:#1e3d2c; --g:#00ff88;--b:#00ccff;--r:#ff3d5f;--y:#ffaa00; --t:#b0f0cc;--t2:#4d9968;--t3:#2a5438; --card:#060d09; } .R{font-family:'Space Mono',monospace;background:var(--bg);color:var(--t);min-height:100vh;display:flex;flex-direction:column} .H{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;background:var(--bg2);border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:200} .Lg{display:flex;align-items:center;gap:9px} .Lh{width:26px;height:26px;background:var(--g);clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)} .Lt{font-family:'Syne',sans-serif;font-weight:800;font-size:15px} .Lt em{color:var(--g);font-style:normal} .Ls{font-size:8px;color:var(--t3);letter-spacing:2px;text-transform:uppercase;margin-top:1px} .Hr{display:flex;align-items:center;gap:12px} .dot{width:7px;height:7px;border-radius:50%;background:var(--t3)} .dot.on{background:var(--g);box-shadow:0 0 8px var(--g);animation:bl 2s infinite} .dot.er{background:var(--r)} @keyframes bl{0%,100%{opacity:1}50%{opacity:.3}} .hl{font-size:9px;color:var(--t2);letter-spacing:1px;text-transform:uppercase} .tag{font-size:8px;padding:3px 7px;border-radius:2px;letter-spacing:1px;text-transform:uppercase} .tag-g{background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.3);color:var(--g)} .tag-b{background:rgba(0,204,255,.1);border:1px solid rgba(0,204,255,.3);color:var(--b)} .B{display:flex;flex:1;min-height:0} .S{width:248px;min-width:248px;background:var(--bg2);border-right:1px solid var(--bd);padding:14px 12px;display:flex;flex-direction:column;gap:16px;overflow-y:auto} .sl{font-size:7.5px;letter-spacing:2.5px;text-transform:uppercase;color:var(--t3);border-bottom:1px solid var(--bd);padding-bottom:5px;margin-bottom:1px} .sc{display:flex;flex-direction:column;gap:8px} .fg{display:flex;flex-direction:column;gap:4px} .fl{font-size:9px;color:var(--t2)} .fi,.fse{background:var(--bg3);border:1px solid var(--bd);color:var(--t);font-family:'Space Mono',monospace;font-size:11px;padding:7px 8px;border-radius:3px;outline:none;width:100%;transition:border-color .15s} .fi:focus,.fse:focus{border-color:var(--g)} .fi::placeholder{color:var(--t3)} .fse option{background:var(--bg3)} .tr{display:flex;align-items:center;justify-content:space-between} .tl{font-size:10px;color:var(--t2)} .tog{position:relative;width:32px;height:17px;cursor:pointer} .tog input{opacity:0;width:0;height:0;position:absolute} .tt{position:absolute;inset:0;background:var(--bg3);border:1px solid var(--bd);border-radius:17px;transition:all .2s} .tog input:checked~.tt{background:var(--g);border-color:var(--g)} .tb{position:absolute;top:3px;left:3px;width:9px;height:9px;border-radius:50%;background:var(--t3);transition:all .2s} .tog input:checked~.tb{transform:translateX(15px);background:var(--bg)} .btn{font-family:'Space Mono',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:8px 12px;border-radius:3px;border:none;cursor:pointer;transition:all .15s;font-weight:700} .bg{background:var(--g);color:var(--bg);width:100%} .bg:hover{filter:brightness(1.15)} .bg:disabled{opacity:.4;cursor:not-allowed} .bst{background:var(--r);color:#fff;width:100%} .bst:hover{filter:brightness(1.15)} .bgh{background:transparent;color:var(--t2);border:1px solid var(--bd)} .bgh:hover{border-color:var(--g);color:var(--g)} .bsm{padding:5px 9px;font-size:8px} .ms{display:flex;gap:5px} .mb{flex:1;padding:7px 5px;background:var(--bg3);border:1px solid var(--bd);border-radius:3px;color:var(--t2);font-family:'Space Mono',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;transition:all .15s;text-align:center} .mb.ma{background:rgba(0,255,136,.1);border-color:var(--g);color:var(--g)} .mb.mm{background:rgba(0,204,255,.1);border-color:var(--b);color:var(--b)} .mb:not(.ma):not(.mm):hover{border-color:var(--bd2);color:var(--t)} .M{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px} .sg{display:grid;grid-template-columns:repeat(4,1fr);gap:9px} .st{background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:11px 13px} .stl{font-size:7.5px;letter-spacing:2px;text-transform:uppercase;color:var(--t3);margin-bottom:4px} .stv{font-family:'Syne',sans-serif;font-size:19px;font-weight:800} .sts{font-size:8px;color:var(--t3);margin-top:2px} .cg{color:var(--g)} .cr{color:var(--r)} .cb{color:var(--b)} .cy{color:var(--y)} .card{background:var(--card);border:1px solid var(--bd);border-radius:4px;padding:12px} .ct{font-family:'Syne',sans-serif;font-size:9px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:2px;margin-bottom:10px} .sb{flex:1;background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:9px 13px;display:flex;align-items:center;gap:11px} .sbi{width:8px;height:8px;border-radius:50%;background:var(--t3)} .sbi.on{background:var(--g);box-shadow:0 0 8px var(--g);animation:bl 1.5s infinite} .tabs{display:flex;gap:2px;border-bottom:1px solid var(--bd);margin-bottom:12px} .tab{font-family:'Space Mono',monospace;font-size:8.5px;letter-spacing:1.5px;text-transform:uppercase;padding:8px 12px;background:none;border:none;color:var(--t3);cursor:pointer;transition:all .15s;border-bottom:2px solid transparent;margin-bottom:-1px} .tab.on{color:var(--g);border-bottom-color:var(--g)} .tab:not(.on):hover{color:var(--t2)} .cb2{display:inline-block;margin-left:4px;font-size:7.5px;color:var(--g)} .sh{display:flex;gap:12px;align-items:stretch} .sm{flex:1;background:var(--bg3);border:1px solid var(--bd);border-radius:4px;padding:13px;display:flex;flex-direction:column;gap:9px} .sm.sc2{border-color:rgba(0,255,136,.4);background:rgba(0,255,136,.03)} .sm.sp{border-color:rgba(255,61,95,.4);background:rgba(255,61,95,.03)} .sd{font-family:'Syne',sans-serif;font-size:26px;font-weight:800;letter-spacing:-1px} .sd.cg2{color:var(--g)} .sd.cr2{color:var(--r)} .ss2{font-size:10px;color:var(--t2)} .gc{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:10px;background:var(--bg3);border:1px solid var(--bd);border-radius:4px;min-width:88px} .gl{font-size:7.5px;color:var(--t3);letter-spacing:1.5px;text-transform:uppercase} .pr{display:flex;gap:7px;margin-top:2px} .ir{display:flex;align-items:center;gap:8px;font-size:9px;padding:3px 0;border-bottom:1px solid var(--bd)} .ir:last-child{border-bottom:none} .pb{background:rgba(0,204,255,.07);border:1px solid rgba(0,204,255,.4);border-radius:4px;padding:13px;display:flex;flex-direction:column;gap:10px;animation:glow .9s ease-in-out infinite alternate} @keyframes glow{from{box-shadow:0 0 4px rgba(0,204,255,.15)}to{box-shadow:0 0 18px rgba(0,204,255,.35)}} .pbt{font-family:'Syne',sans-serif;font-size:10px;font-weight:700;color:var(--b);letter-spacing:1px} .pa{display:flex;gap:7px} .bex{flex:1;font-family:'Space Mono',monospace;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:9px;border:none;border-radius:3px;cursor:pointer;transition:all .15s} .bex.gc3{background:var(--g);color:var(--bg)} .bex.rc3{background:var(--r);color:#fff} .bex:hover{filter:brightness(1.2)} .bsk{background:transparent;color:var(--t2);border:1px solid var(--bd);font-family:'Space Mono',monospace;font-size:9px;padding:9px 13px;border-radius:3px;cursor:pointer;transition:all .15s} .bsk:hover{border-color:var(--r);color:var(--r)} .shr{display:flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid var(--bd);border-radius:3px;background:var(--bg3);margin-bottom:4px;animation:fi2 .25s ease} @keyframes fi2{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}} .db{font-size:8.5px;font-weight:700;letter-spacing:1px;padding:2px 6px;border-radius:2px;min-width:36px;text-align:center} .db.CALL{background:rgba(0,255,136,.1);color:var(--g);border:1px solid rgba(0,255,136,.25)} .db.PUT{background:rgba(255,61,95,.1);color:var(--r);border:1px solid rgba(255,61,95,.25)} .sr2{flex:1;font-size:9.5px;color:var(--t2)} .sst{font-size:10px;font-weight:700;min-width:34px;text-align:right} .stim{font-size:8.5px;color:var(--t3);min-width:50px;text-align:right} .strb{display:flex;align-items:center;gap:5px} .strtr{width:44px;height:3px;background:var(--bd);border-radius:2px;overflow:hidden} .strfi{height:100%;border-radius:2px;transition:width .4s} .trow{display:grid;grid-template-columns:60px 42px 54px 66px 66px 66px;gap:5px;align-items:center;padding:6px 9px;border-bottom:1px solid var(--bd);font-size:9.5px} .trow:hover{background:var(--bg3)} .trow.th{color:var(--t3);font-size:7.5px;letter-spacing:1px;text-transform:uppercase} .pp{color:var(--g)} .pn{color:var(--r)} .oc{display:flex;align-items:center;gap:7px;padding:8px 9px;border:1px solid var(--bd);border-radius:3px;background:var(--bg3);margin-bottom:4px} .lr{display:flex;gap:7px;padding:4px 0;border-bottom:1px solid rgba(20,42,28,.5);font-size:9.5px;line-height:1.5} .lt{color:var(--t3);min-width:54px} .lm{flex:1} .lm.success{color:var(--g)} .lm.error{color:var(--r)} .lm.warning{color:var(--y)} .lm.signal{color:var(--b)} .rb{width:100%;height:3.5px;background:var(--bd);border-radius:2px;overflow:hidden;margin-top:3px} .rf{height:100%;border-radius:2px;transition:width .5s,background .5s} .em{text-align:center;padding:28px;color:var(--t3);font-size:9.5px} .hn{font-size:8.5px;background:rgba(0,255,136,.05);border:1px solid rgba(0,255,136,.18);border-radius:3px;padding:7px 9px;color:var(--g);line-height:1.7} ::-webkit-scrollbar{width:3px;height:3px} ::-webkit-scrollbar-track{background:var(--bg)} ::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px} @media(max-width:840px){.B{flex-direction:column}.S{width:100%;min-width:0}.sg{grid-template-columns:repeat(2,1fr)}}`;

return (
<>
<style>{CSS}</style>
<div className="R">
{/* ── Header ── */}
<header className="H">
<div className="Lg">
<div className="Lh" />
<div>
<div className="Lt">DERIV<em>BOT</em></div>
<div className="Ls">Hybrid Auto Trader v2</div>
</div>
</div>
<div className="Hr">
<div className={`dot ${wsStatus === "connected" ? "on" : wsStatus === "error" ? "er" : ""}`} />
<span className="hl">{wsStatus}</span>
{authorized && (
<span style={{ fontSize: 9, color: “var(–t2)” }}>
{accountInfo?.loginid} · {accountInfo?.currency} {balance?.toFixed(2)}
</span>
)}
{botRunning && execMode === “auto”   && <span className="tag tag-g">Auto</span>}
{botRunning && execMode === “manual” && <span className="tag tag-b">Manual</span>}
{!connected && (
<button className="btn bgh bsm" onClick={connect}>Connect</button>
)}
</div>
</header>

```
    <div className="B">
      {/* ── Sidebar ── */}
      <aside className="S">
        {/* Authorization */}
        <div className="sc">
          <div className="sl">Authorization</div>
          {!authorized ? (
            <>
              <div className="fg">
                <label className="fl">API Token</label>
                <input className="fi" type="password" placeholder="Paste Deriv token..."
                  value={tokenInput} onChange={e => setTokenInput(e.target.value)} />
              </div>
              {/* FIX #8: removed the "Demo Account" toggle — it had no effect.
                  Demo vs real is determined entirely by which token you paste. */}
              <div style={{ fontSize: 8.5, color: "var(--t3)", lineHeight: 1.6 }}>
                Use a <strong style={{ color: "var(--t2)" }}>demo token</strong> for testing.
                Demo vs real is set by your token type in the Deriv dashboard.
              </div>
              <button
                className="btn bg"
                onClick={connected ? authorize : () => { connect(); setTimeout(authorize, 1600); }}
                disabled={!tokenInput.trim()}
              >
                {connected ? "Authorize" : "Connect & Auth"}
              </button>
            </>
          ) : (
            <div style={{ fontSize: 9, color: "var(--g)" }}>✓ {accountInfo?.loginid} authorized</div>
          )}
        </div>

        {/* Execution Mode */}
        <div className="sc">
          <div className="sl">Execution Mode</div>
          <div className="ms">
            <button className={`mb ${execMode === "auto"   ? "ma" : ""}`}
              onClick={() => setExecMode("auto")}   disabled={botRunning}>⚡ Auto</button>
            <button className={`mb ${execMode === "manual" ? "mm" : ""}`}
              onClick={() => setExecMode("manual")} disabled={botRunning}>✋ Manual</button>
          </div>
          <div style={{ fontSize: 8.5, color: "var(--t3)", lineHeight: 1.6 }}>
            {execMode === "auto"
              ? "Trades fire automatically when signal strength clears your threshold."
              : "Signals queue for your review. You execute or skip each one."}
          </div>
        </div>

        {/* Strategy */}
        <div className="sc">
          <div className="sl">Strategy</div>
          <div className="fg">
            <label className="fl">Algorithm</label>
            <select className="fse" value={strategy}
              onChange={e => setStrategy(e.target.value)} disabled={botRunning}>
              {STRATEGIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 8.5, color: "var(--t3)", lineHeight: 1.6 }}>
            {STRATEGIES.find(s => s.value === strategy)?.desc}
          </div>
          {strategy === "HYBRID" && (
            <div className="hn">RSI 35% · Bollinger 35% · EMA 30%<br />Fires only when 2 of 3 agree</div>
          )}
        </div>

        {/* Instrument */}
        <div className="sc">
          <div className="sl">Instrument</div>
          <div className="fg">
            <label className="fl">Symbol</label>
            <select className="fse" value={symbol}
              onChange={e => setSymbol(e.target.value)} disabled={botRunning}>
              {SYMBOLS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="fg">
            <label className="fl">Contract Duration</label>
            <select className="fse" value={duration}
              onChange={e => setDuration(parseInt(e.target.value, 10))} disabled={botRunning}>
              {DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
        </div>

        {/* Stake & Risk */}
        <div className="sc">
          <div className="sl">Stake & Risk</div>
          {[
            ["Stake Amount",            stake,        setStake,        "0.35", "0.1"],
            ["Min Signal Strength (%)", minStrength,  setMinStrength,  "50",   "1"  ],
            ["Max Daily Loss",          maxDailyLoss, setMaxDailyLoss, "1",    "1"  ],
            ["Max Daily Trades",        maxTrades,    setMaxTrades,    "1",    "1"  ],
          ].map(([label, val, setter, min, step]) => (
            <div key={label} className="fg">
              <label className="fl">{label}</label>
              <input className="fi" type="number" min={min} step={step}
                value={val} onChange={e => setter(e.target.value)} disabled={botRunning} />
            </div>
          ))}
          <div className="tr">
            <span className="tl">Martingale</span>
            <label className="tog">
              <input type="checkbox" checked={martingale}
                onChange={e => setMartingale(e.target.checked)} disabled={botRunning} />
              <div className="tt" /><div className="tb" />
            </label>
          </div>
          {martingale && (
            <div className="fg">
              <label className="fl">Multiplier on Loss</label>
              <input className="fi" type="number" min="1.1" step="0.1"
                value={martMul} onChange={e => setMartMul(e.target.value)} disabled={botRunning} />
            </div>
          )}
        </div>

        {/* Bot Controls */}
        <div className="sc">
          <div className="sl">Bot Control</div>
          {!botRunning
            ? <button className="btn bg" onClick={startBot} disabled={!authorized}>▶ Start Bot</button>
            : <button className="btn bst" onClick={stopBot}>■ Stop Bot</button>
          }
          <button className="btn bgh bsm" onClick={resetDay} style={{ marginTop: 3 }}>
            Reset Day
          </button>
        </div>
      </aside>

      {/* ── Main Area ── */}
      <main className="M">
        {/* Stats row */}
        <div className="sg">
          {[
            ["Live Price",   currentPrice ? currentPrice.toFixed(2) : "—", symInfo?.label,             botRunning ? "cg" : ""],
            ["Today P&L",    `${dailyPnL >= 0 ? "+" : ""}${dailyPnL.toFixed(2)}`, accountInfo?.currency || "USD", dailyPnL >= 0 ? "cg" : "cr"],
            ["Win Rate",     winRate !== null ? `${winRate}%` : "—", `${trades.length} trades`,  winRate !== null ? (parseFloat(winRate) >= 50 ? "cg" : "cr") : ""],
            ["Trades Today", String(todayTrades), `of ${maxTrades}`, "cb"],
          ].map(([label, val, sub, cls]) => (
            <div key={label} className="st">
              <div className="stl">{label}</div>
              <div className={`stv ${cls}`}>{val}</div>
              <div className="sts">{sub}</div>
            </div>
          ))}
        </div>

        {/* Status bar + sparkline */}
        <div style={{ display: "flex", gap: 10 }}>
          <div className="sb">
            <div className={`sbi ${botRunning ? "on" : ""}`} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10 }}>{botRunning ? "Bot active" : "Bot stopped"}</div>
              <div style={{ fontSize: 8, color: "var(--t3)", marginTop: 2 }}>
                {STRATEGIES.find(s => s.value === strategy)?.label} · {symInfo?.tag} · {duration}m · {execMode === "auto" ? "Auto-execute" : "Manual-confirm"}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 7.5, color: "var(--t3)", marginBottom: 2 }}>Loss Risk</div>
              <div className="rb" style={{ width: 70 }}>
                <div className="rf" style={{ width: `${lossRatio}%`, background: riskColor }} />
              </div>
              <div style={{ fontSize: 8, color: riskColor, marginTop: 2 }}>{lossRatio.toFixed(0)}%</div>
            </div>
          </div>
          <div className="card" style={{ padding: "9px 12px", display: "flex", alignItems: "center", flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: 7.5, color: "var(--t3)", letterSpacing: 1, marginBottom: 3 }}>PRICE FEED</div>
              <Sparkline data={priceHistory.slice(-80)} color={botRunning ? "#00ff88" : "#2a5438"} />
            </div>
          </div>
        </div>

        {/* Pending signal banner (manual mode only) */}
        {execMode === "manual" && pendingSignal && (
          <div className="pb">
            <div className="pbt">⚡ Signal Ready — Confirm to Trade</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <StrengthGauge value={pendingSignal.strength} size={62} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 16,
                  color: pendingSignal.direction === "CALL" ? "var(--g)" : "var(--r)" }}>
                  {pendingSignal.direction}
                </div>
                <div style={{ fontSize: 9.5, color: "var(--t2)", marginTop: 3 }}>{pendingSignal.summary}</div>
                <div style={{ fontSize: 8.5, color: "var(--t3)", marginTop: 2 }}>
                  Stake: {currentStakeRef.current?.toFixed(2)} · {duration}m · @ {pendingSignal.price}
                </div>
              </div>
            </div>
            {pendingSignal.components && (
              <div className="pr">
                <Pill label="RSI" score={pendingSignal.components.rsi.score} agrees={pendingSignal.components.rsi.agrees} vote={pendingSignal.components.rsi.vote} />
                <Pill label="BB"  score={pendingSignal.components.bb.score}  agrees={pendingSignal.components.bb.agrees}  vote={pendingSignal.components.bb.vote}  />
                <Pill label="EMA" score={pendingSignal.components.ema.score} agrees={pendingSignal.components.ema.agrees} vote={pendingSignal.components.ema.vote} />
              </div>
            )}
            <div className="pa">
              <button className={`bex ${pendingSignal.direction === "CALL" ? "gc3" : "rc3"}`}
                onClick={() => placeTrade(pendingSignal)}>
                Execute {pendingSignal.direction}
              </button>
              <button className="bsk" onClick={dismissSignal}>Skip</button>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div>
          <div className="tabs">
            {[
              { id: "signal",  label: "Live Signal" },
              { id: "history", label: "History", count: signals.length },
              { id: "trades",  label: "Trades",  count: trades.length   },
              { id: "log",     label: "Log",     count: logs.length     },
            ].map(t => (
              <button key={t.id} className={`tab ${activeTab === t.id ? "on" : ""}`}
                onClick={() => setActiveTab(t.id)}>
                {t.label}
                {t.count > 0 && <span className="cb2">{t.count}</span>}
              </button>
            ))}
          </div>

          {/* Live Signal tab */}
          {activeTab === "signal" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {liveSignal ? (
                <>
                  <div className="sh">
                    <div className={`sm ${liveSignal.direction === "CALL" ? "sc2" : "sp"}`}>
                      <div>
                        <div className={`sd ${liveSignal.direction === "CALL" ? "cg2" : "cr2"}`}>
                          {liveSignal.direction}
                        </div>
                        <div className="ss2">{liveSignal.summary}</div>
                        {liveSignal.allAgree && (
                          <div style={{ fontSize: 8, color: "var(--g)", marginTop: 3, letterSpacing: 1 }}>
                            ★ ALL 3 INDICATORS AGREE
                          </div>
                        )}
                      </div>

                      <div style={{ fontSize: 9, color: liveSignal.strength >= parseFloat(minStrength) ? "var(--g)" : "var(--y)" }}>
                        {liveSignal.strength >= parseFloat(minStrength)
                          ? `✓ ${liveSignal.strength}% clears threshold (${minStrength}%) — ${execMode === "auto" ? "auto-trading" : "queued for confirmation"}`
                          : `⚠ ${liveSignal.strength}% below threshold (${minStrength}%) — monitoring only`}
                      </div>

                      {liveSignal.components && (
                        <div className="pr">
                          <Pill label="RSI" score={liveSignal.components.rsi.score} agrees={liveSignal.components.rsi.agrees} vote={liveSignal.components.rsi.vote} />
                          <Pill label="BB"  score={liveSignal.components.bb.score}  agrees={liveSignal.components.bb.agrees}  vote={liveSignal.components.bb.vote}  />
                          <Pill label="EMA" score={liveSignal.components.ema.score} agrees={liveSignal.components.ema.agrees} vote={liveSignal.components.ema.vote} />
                        </div>
                      )}

                      {liveSignal.components && (
                        <div style={{ background: "var(--bg)", borderRadius: 3, padding: "8px 10px" }}>
                          {[
                            ["RSI", liveSignal.components.rsi],
                            ["BB",  liveSignal.components.bb ],
                            ["EMA", liveSignal.components.ema],
                          ].map(([name, comp]) => (
                            <div key={name} className="ir">
                              <span style={{ fontSize: 8, color: "var(--t3)", width: 24 }}>{name}</span>
                              <span style={{ flex: 1, color: "var(--t2)" }}>{comp.label}</span>
                              <span style={{ fontSize: 8, color: comp.agrees ? "var(--g)" : "var(--r)" }}>
                                {comp.agrees ? "✓ agrees" : "✗ opposed"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="gc">
                      <div className="gl">Strength</div>
                      <StrengthGauge value={liveSignal.strength} size={74} />
                      <div style={{ fontSize: 8, color: "var(--t3)", textAlign: "center", lineHeight: 1.6 }}>
                        {liveSignal.strength >= 80 ? "HIGH" : liveSignal.strength >= 65 ? "MED" : "LOW"}
                        <br />CONVICTION
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="ct">Risk Guards</div>
                    {[
                      ["Daily Loss",      `${Math.abs(Math.min(0, dailyPnL)).toFixed(2)} / ${maxDailyLoss}`, lossRatio,                       riskColor                                          ],
                      ["Trades Used",     `${todayTrades} / ${maxTrades}`,                                   tradeRatio,                      "var(--b)"                                         ],
                      ["Consec. Losses",  `${consecLosses} / 5`,                                             (consecLosses / 5) * 100,         consecLosses >= 3 ? "var(--r)" : "var(--g)"       ],
                    ].map(([label, val, pct, col]) => (
                      <div key={label} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9 }}>
                          <span style={{ color: "var(--t2)" }}>{label}</span>
                          <span style={{ color: col }}>{val}</span>
                        </div>
                        <div className="rb">
                          <div className="rf" style={{ width: `${pct}%`, background: col }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="em">
                  {botRunning
                    ? `Scanning for signals... (${priceHistory.length}/35 ticks collected)`
                    : "Start the bot to see live signal analysis here"}
                </div>
              )}
            </div>
          )}

          {/* History tab */}
          {activeTab === "history" && (
            <div>
              {signals.length === 0 ? (
                <div className="em">No signals generated yet</div>
              ) : signals.map(sig => {
                const sc = strColor(sig.strength);
                return (
                  <div key={sig.id} className="shr">
                    <span className={`db ${sig.direction}`}>{sig.direction}</span>
                    <span className="sr2">{sig.summary}</span>
                    <div className="strb">
                      <div className="strtr">
                        <div className="strfi" style={{ width: `${sig.strength}%`, background: sc }} />
                      </div>
                      <span className="sst" style={{ color: sc }}>{sig.strength}%</span>
                    </div>
                    <span style={{ fontSize: 8, color: sig.acted ? "var(--g)" : "var(--t3)", minWidth: 38, textAlign: "right" }}>
                      {sig.acted ? "TRADED" : "SKIPPED"}
                    </span>
                    <span className="stim">{sig.time}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Trades tab */}
          {activeTab === "trades" && (
            <div>
              {openContracts.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div className="ct">Open Contracts ({openContracts.length})</div>
                  {openContracts.map(c => (
                    <div key={c.id} className="oc">
                      <span className={`db ${c.direction}`}>{c.direction}</span>
                      <span style={{ fontSize: 9, flex: 1 }}>#{c.id}</span>
                      <span style={{ fontSize: 9, color: "var(--t2)" }}>Stake: {c.buyPrice}</span>
                      <span style={{ fontSize: 8, color: "var(--t3)" }}>{c.openTime}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="trow th">
                <span>Time</span><span>Dir</span><span>Symbol</span>
                <span>Stake</span><span>Payout</span><span>P&L</span>
              </div>
              {trades.length === 0 ? (
                <div className="em">No completed trades</div>
              ) : trades.map(t => (
                <div key={t.id} className="trow">
                  <span style={{ color: "var(--t3)" }}>{t.time}</span>
                  <span className={`db ${t.direction}`} style={{ padding: "1px 4px" }}>{t.direction}</span>
                  <span style={{ color: "var(--t2)" }}>{t.symbol}</span>
                  <span>{t.stake.toFixed(2)}</span>
                  <span style={{ color: "var(--t2)" }}>{t.payout.toFixed(2)}</span>
                  <span className={t.won ? "pp" : "pn"}>
                    {t.profit >= 0 ? "+" : ""}{t.profit.toFixed(2)}
                  </span>
                </div>
              ))}
              {trades.length > 0 && (
                <div style={{ padding: "9px 9px 0", borderTop: "1px solid var(--bd)",
                  display: "flex", justifyContent: "space-between", fontSize: 9.5 }}>
                  <span style={{ color: "var(--t2)" }}>Total P&L</span>
                  <span className={totalPnL >= 0 ? "pp" : "pn"}>
                    {totalPnL >= 0 ? "+" : ""}{totalPnL.toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Log tab */}
          {activeTab === "log" && (
            <div style={{ maxHeight: 380, overflowY: "auto" }}>
              {logs.length === 0 ? (
                <div className="em">No log entries</div>
              ) : logs.map(l => (
                <div key={l.id} className="lr">
                  <span className="lt">{l.time}</span>
                  <span className={`lm ${l.type}`}>{l.msg}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  </div>
</>
```

);
}