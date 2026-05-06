import {
    DEFAULT_CONFIG,
    createInitialState,
    runTick,
    makePRNG
} from "./simulation-core.js";

const { useState, useEffect, useRef, useCallback } = React;

// ─── helpers ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Stability Index ─────────────────────────────────────────────────────────
// StabilityIndex = 1 – (0.4·var(modeIntensity) + 0.3·normCrises + 0.3·avgGaming)
// All components normalised to [0,1] before weighting.
function computeStabilityIndex(history, crisisCount, ticks) {
    const modes = history.mode;
    if (!modes || modes.length < 2) return null;
    const mean = modes.reduce((a, b) => a + b, 0) / modes.length;
    const variance = modes.reduce((s, v) => s + (v - mean) ** 2, 0) / modes.length;
    // variance of mode intensity is in [0, ~0.64] (max when all 0 or all 1)
    const normVariance = clamp(variance / 0.25, 0, 1);
    const normCrises   = clamp(crisisCount / 10, 0, 1);
    // approximate avg gaming from divergence proxy (divergence ≈ gaming effect)
    const divArr = history.divergence;
    const avgDiv = divArr.reduce((a, b) => a + b, 0) / divArr.length;
    const normGaming = clamp(avgDiv / 0.5, 0, 1);

    const instability = 0.4 * normVariance + 0.3 * normCrises + 0.3 * normGaming;
    return clamp(1 - instability, 0, 1);
}

function stabilityLabel(si) {
    if (si === null) return "—";
    if (si >= 0.80) return "High Stability";
    if (si >= 0.55) return "Moderate Stability";
    if (si >= 0.30) return "Low Stability";
    return "Unstable";
}

// ─── Resilience Score ────────────────────────────────────────────────────────
// ResilienceScore = speed_of_recovery – damage_penalty – capture_growth_penalty
// speed_of_recovery  = 1 / (1 + avgCrisisDuration)   where avgCrisisDuration estimated from crisisCount & ticks in crisis
// damage_penalty     = (1 – finalAinoHealth)
// capture_growth_penalty = finalCaptureRisk
function computeResilienceScore(history, crisisCount, finalAinoHealth, finalCaptureRisk, ticks) {
    const modes = history.mode;
    if (!modes || modes.length < 2) return null;

    // Count ticks in crisis (modeIntensity === 1.0)
    const crisisTicks = modes.filter(m => m >= 1.0).length;
    const avgCrisisDuration = crisisCount > 0 ? crisisTicks / crisisCount : 0;
    const speedOfRecovery = 1 / (1 + avgCrisisDuration / ticks * 10);

    const damagePenalty = 1 - finalAinoHealth;
    const capturePenalty = finalCaptureRisk;

    const raw = speedOfRecovery - 0.4 * damagePenalty - 0.3 * capturePenalty;
    return clamp(raw, 0, 1);
}

function resilienceLabel(rs) {
    if (rs === null) return "—";
    if (rs >= 0.75) return "High Resilience";
    if (rs >= 0.50) return "Moderate Resilience";
    if (rs >= 0.25) return "Low Resilience";
    return "Fragile";
}

// ─── MiniChart ───────────────────────────────────────────────────────────────
function MiniChart({ data, color, label, height = 60, interventionMarkers = [], recoveryHealthMarkers = [], showRecoveryDots = false }) {
    if (!data || data.length < 2) return null;
    const n = data.length;
    const w = 260, h = height;
    const pts = data.map((v, i) => `${(i / (n - 1)) * w},${h - v * h}`).join(" ");

    return (
        <div className="mb-1">
            <div className="text-xs text-gray-400 mb-0.5">{label}</div>
            <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h}
                className="bg-gray-900 rounded" style={{ overflow: 'visible', display: 'block' }}>
                <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
                {interventionMarkers.map((tick, i) => {
                    const x = n > 1 ? (tick / (n - 1)) * w : 0;
                    return <line key={`iv-${i}`} x1={x} y1={0} x2={x} y2={h}
                        stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3,2" opacity="0.85" />;
                })}
                {showRecoveryDots && recoveryHealthMarkers.map((m, i) => {
                    const x = n > 1 ? (m.tick / (n - 1)) * w : 0;
                    return (
                        <g key={`rh-${i}`}>
                            <circle cx={x} cy={h - m.baseHealth * h} r="4" fill="#f59e0b" stroke="#fff" strokeWidth="1" opacity="0.9" />
                            <circle cx={x} cy={h - m.ainoHealth * h} r="4" fill="#a78bfa" stroke="#fff" strokeWidth="1" opacity="0.9" />
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

// ─── Histogram (SVG) ─────────────────────────────────────────────────────────
function Histogram({ values, color, label, bins = 12, width = 260, height = 80 }) {
    if (!values || values.length === 0) return null;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 0.001;
    const counts = Array(bins).fill(0);
    values.forEach(v => {
        const b = Math.min(bins - 1, Math.floor(((v - min) / range) * bins));
        counts[b]++;
    });
    const maxCount = Math.max(...counts);
    const bw = width / bins;

    return (
        <div className="mb-2">
            <div className="text-xs text-gray-400 mb-0.5">{label}</div>
            <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}
                className="bg-gray-900 rounded" style={{ display: 'block' }}>
                {counts.map((c, i) => {
                    const bh = maxCount > 0 ? (c / maxCount) * (height - 10) : 0;
                    return <rect key={i} x={i * bw + 1} y={height - bh - 5}
                        width={bw - 2} height={bh} fill={color} opacity="0.8" rx="1" />;
                })}
                {/* axis labels */}
                <text x={2} y={height - 1} fontSize="7" fill="#6b7280">{min.toFixed(2)}</text>
                <text x={width - 2} y={height - 1} fontSize="7" fill="#6b7280" textAnchor="end">{max.toFixed(2)}</text>
            </svg>
        </div>
    );
}

// ─── Gauge (SVG arc) ─────────────────────────────────────────────────────────
function Gauge({ value, label, color }) {
    if (value === null || value === undefined) return (
        <div className="flex flex-col items-center">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="text-lg font-bold text-gray-600">—</div>
        </div>
    );
    const pct = clamp(value, 0, 1);
    const r = 28, cx = 36, cy = 36;
    const startAngle = Math.PI;
    const endAngle = 0;
    const angle = startAngle + pct * (endAngle - startAngle + Math.PI); // 180° sweep
    const x = cx + r * Math.cos(Math.PI + pct * Math.PI);
    const y = cy + r * Math.sin(Math.PI + pct * Math.PI);
    const bgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
    const fgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`;

    return (
        <div className="flex flex-col items-center">
            <svg width="72" height="44" viewBox="0 0 72 44">
                <path d={bgPath} fill="none" stroke="#374151" strokeWidth="8" strokeLinecap="round" />
                <path d={fgPath} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" />
                <text x={cx} y={cy + 10} textAnchor="middle" fontSize="11" fontWeight="bold" fill={color}>
                    {(pct * 100).toFixed(0)}
                </text>
            </svg>
            <div className="text-xs text-gray-400 text-center leading-tight">{label}</div>
        </div>
    );
}

// ─── Monte Carlo Panel ────────────────────────────────────────────────────────
function MonteCarloPanel({ cfg, onClose }) {
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState(null);
    const [progress, setProgress] = useState(0);
    const [mcRuns, setMcRuns] = useState(100);
    const workerRef = useRef(null);

    const run = useCallback(() => {
        setRunning(true);
        setResults(null);
        setProgress(0);

        if (!workerRef.current) {
            workerRef.current = new Worker("worker.js");
        }
        const worker = workerRef.current;
        worker.onmessage = (e) => {
            if (e.data.type === "montecarlo_result") {
                setResults(e.data.results);
                setRunning(false);
                setProgress(100);
            }
        };
        worker.postMessage({
            type: "montecarlo",
            cfg,
            mcRuns,
            mcSeedBase: cfg.randomSeed
        });

        // Fake progress bar (worker is synchronous internally)
        let p = 0;
        const iv = setInterval(() => {
            p = Math.min(p + 2, 95);
            setProgress(p);
            if (p >= 95) clearInterval(iv);
        }, 80);
    }, [cfg, mcRuns]);

    const stats = results ? (() => {
        const ainoHealths = results.map(r => r.finalAinoHealth);
        const baseHealths = results.map(r => r.finalBaseHealth);
        const crises      = results.map(r => r.crisisCount);
        const captures    = results.map(r => r.finalCaptureRisk);
        const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
        const std = arr => { const m = avg(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); };
        const pCrisis = results.filter(r => r.crisisCount > 0).length / results.length;
        const worst = results.reduce((a, b) => a.finalAinoHealth < b.finalAinoHealth ? a : b);
        const best  = results.reduce((a, b) => a.finalAinoHealth > b.finalAinoHealth ? a : b);
        return { ainoHealths, baseHealths, crises, captures, avg, std, pCrisis, worst, best };
    })() : null;

    return (
        <div className="bg-gray-900 rounded border border-blue-700 p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-bold text-blue-300">🎲 Monte Carlo Analysis</div>
                <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300">✕ close</button>
            </div>

            <div className="flex items-center gap-3 mb-3 text-xs">
                <label className="text-gray-400">Runs:
                    <input type="range" min="20" max="500" step="10" value={mcRuns}
                        onChange={e => setMcRuns(Number(e.target.value))}
                        className="ml-2 w-28 align-middle" />
                    <span className="ml-1 text-white font-bold">{mcRuns}</span>
                </label>
                <button onClick={run} disabled={running}
                    className="px-3 py-1 rounded font-bold bg-blue-700 hover:bg-blue-600 disabled:opacity-40">
                    {running ? `Running… ${progress}%` : "▶ Run Monte Carlo"}
                </button>
            </div>

            {running && (
                <div className="w-full h-2 bg-gray-800 rounded overflow-hidden mb-3">
                    <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
                </div>
            )}

            {stats && (
                <div>
                    <div className="grid grid-cols-4 gap-3 text-xs mb-3">
                        <div className="bg-gray-800 rounded p-2">
                            <div className="text-gray-400">Avg AïnO Health</div>
                            <div className="text-xl font-bold text-purple-400">{(stats.avg(stats.ainoHealths) * 100).toFixed(1)}%</div>
                            <div className="text-gray-500">±{(stats.std(stats.ainoHealths) * 100).toFixed(1)}%</div>
                        </div>
                        <div className="bg-gray-800 rounded p-2">
                            <div className="text-gray-400">Avg Crises</div>
                            <div className="text-xl font-bold text-red-400">{stats.avg(stats.crises).toFixed(1)}</div>
                            <div className="text-gray-500">P(crisis)={( stats.pCrisis * 100).toFixed(0)}%</div>
                        </div>
                        <div className="bg-gray-800 rounded p-2">
                            <div className="text-gray-400">Avg Capture Risk</div>
                            <div className="text-xl font-bold text-orange-400">{(stats.avg(stats.captures) * 100).toFixed(1)}%</div>
                            <div className="text-gray-500">±{(stats.std(stats.captures) * 100).toFixed(1)}%</div>
                        </div>
                        <div className="bg-gray-800 rounded p-2">
                            <div className="text-gray-400">Best / Worst</div>
                            <div className="text-sm font-bold">
                                <span className="text-green-400">{(stats.best.finalAinoHealth * 100).toFixed(0)}%</span>
                                {" / "}
                                <span className="text-red-400">{(stats.worst.finalAinoHealth * 100).toFixed(0)}%</span>
                            </div>
                            <div className="text-gray-500">AïnO health</div>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Histogram values={stats.ainoHealths} color="#a78bfa" label="Distribution: Final AïnO Health" bins={14} />
                            <Histogram values={stats.crises} color="#f87171" label="Distribution: Crisis Count" bins={10} />
                        </div>
                        <div>
                            <Histogram values={stats.captures} color="#fb923c" label="Distribution: Capture Risk" bins={14} />
                            <Histogram values={stats.baseHealths} color="#f59e0b" label="Distribution: Final Baseline Health" bins={14} />
                        </div>
                    </div>

                    {/* Best / Worst trajectories */}
                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <MiniChart data={stats.best.ainoHealthHistory}  color="#4ade80" label="Best-case AïnO trajectory" height={50} />
                        <MiniChart data={stats.worst.ainoHealthHistory} color="#f87171" label="Worst-case AïnO trajectory" height={50} />
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Governance Dashboard ─────────────────────────────────────────────────────
function GovernanceDashboard({ state, cfg, finished }) {
    const history = state.history;
    const finalAinoHealth = history.ainoHealth.at(-1) ?? 0;
    const finalBaseHealth = history.baseHealth.at(-1) ?? 0;

    const si = finished ? computeStabilityIndex(history, state.crisisEventCount, cfg.ticks) : null;
    const rs = finished ? computeResilienceScore(history, state.crisisEventCount, finalAinoHealth, state.captureRisk, cfg.ticks) : null;

    const siLabel = stabilityLabel(si);
    const rsLabel = resilienceLabel(rs);

    // Composite governance score
    const govScore = (si !== null && rs !== null)
        ? clamp((si * 0.5 + rs * 0.5), 0, 1)
        : null;

    const govLabel = govScore === null ? "—"
        : govScore >= 0.75 ? "Strong Governance"
        : govScore >= 0.50 ? "Adequate Governance"
        : govScore >= 0.25 ? "Weak Governance"
        : "Governance Failure";

    const govColor = govScore === null ? "#6b7280"
        : govScore >= 0.75 ? "#4ade80"
        : govScore >= 0.50 ? "#facc15"
        : govScore >= 0.25 ? "#fb923c"
        : "#ef4444";

    return (
        <div className="bg-gray-900 rounded border border-purple-700 p-4 mb-4">
            <div className="text-sm font-bold text-purple-300 mb-3">🏛 Governance Dashboard</div>

            {!finished && (
                <div className="text-xs text-gray-500 italic">Run the simulation to completion to see governance metrics.</div>
            )}

            {finished && (
                <>
                    {/* Three gauges */}
                    <div className="flex justify-around mb-4">
                        <Gauge value={si}       label={`Stability Index\n${siLabel}`}  color="#60a5fa" />
                        <Gauge value={rs}       label={`Resilience Score\n${rsLabel}`} color="#34d399" />
                        <Gauge value={govScore} label={`Governance Score\n${govLabel}`} color={govColor} />
                    </div>

                    {/* Metric cards */}
                    <div className="grid grid-cols-3 gap-3 text-xs mb-3">
                        <div className="bg-gray-800 rounded p-2 border border-blue-900">
                            <div className="text-blue-300 font-bold mb-1">📐 Stability Index</div>
                            <div className="text-2xl font-bold text-blue-400">{si !== null ? si.toFixed(3) : "—"}</div>
                            <div className="text-gray-400 mt-1">{siLabel}</div>
                            <div className="text-gray-500 mt-1 leading-tight">
                                Measures how calm and predictable the governance system was.
                                High = low volatility, few crises, low divergence.
                            </div>
                        </div>
                        <div className="bg-gray-800 rounded p-2 border border-green-900">
                            <div className="text-green-300 font-bold mb-1">🔄 Resilience Score</div>
                            <div className="text-2xl font-bold text-green-400">{rs !== null ? rs.toFixed(3) : "—"}</div>
                            <div className="text-gray-400 mt-1">{rsLabel}</div>
                            <div className="text-gray-500 mt-1 leading-tight">
                                Measures how quickly the system recovers from shocks.
                                High = short crises, fast recovery, low capture risk.
                            </div>
                        </div>
                        <div className="bg-gray-800 rounded p-2 border border-purple-900">
                            <div className="font-bold mb-1" style={{ color: govColor }}>⚖️ Governance Score</div>
                            <div className="text-2xl font-bold" style={{ color: govColor }}>{govScore !== null ? govScore.toFixed(3) : "—"}</div>
                            <div className="text-gray-400 mt-1">{govLabel}</div>
                            <div className="text-gray-500 mt-1 leading-tight">
                                Composite of Stability + Resilience.
                                Overall governance quality indicator.
                            </div>
                        </div>
                    </div>

                    {/* Formula reference */}
                    <details className="text-xs text-gray-500">
                        <summary className="cursor-pointer hover:text-gray-300">📖 Formula reference</summary>
                        <div className="mt-2 bg-gray-800 rounded p-2 font-mono text-gray-400 leading-relaxed">
                            <div className="mb-1 text-gray-300">Stability Index</div>
                            <div>= 1 – (0.4·norm_variance(modeIntensity)</div>
                            <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ 0.3·norm(crisisCount/10)</div>
                            <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ 0.3·norm(avgDivergence/0.5))</div>
                            <div className="mt-2 mb-1 text-gray-300">Resilience Score</div>
                            <div>= 1/(1 + avgCrisisDuration·10/ticks)</div>
                            <div>&nbsp;&nbsp;– 0.4·(1 – finalAïnOHealth)</div>
                            <div>&nbsp;&nbsp;– 0.3·finalCaptureRisk</div>
                            <div className="mt-2 mb-1 text-gray-300">Governance Score</div>
                            <div>= 0.5·StabilityIndex + 0.5·ResilienceScore</div>
                        </div>
                    </details>
                </>
            )}
        </div>
    );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
    const [cfg, setCfg] = useState(DEFAULT_CONFIG);
    const [state, setState] = useState(() => createInitialState(DEFAULT_CONFIG));
    const [running, setRunning] = useState(false);
    const [finished, setFinished] = useState(false);
    const [useWorker, setUseWorker] = useState(false);
    const [showMonteCarlo, setShowMonteCarlo] = useState(false);

    const intervalRef = useRef(null);
    const workerRef   = useRef(null);

    const reset = useCallback(() => {
        setRunning(false);
        setFinished(false);
        clearInterval(intervalRef.current);
        setState(createInitialState(cfg));
    }, [cfg]);

    const triggerShock = useCallback(() => {
        setState(s => ({ ...s, shockActive: true, shockDaysRemaining: cfg.shockDurationDays }));
    }, [cfg.shockDurationDays]);

    const triggerIntervention = useCallback(() => {
        setState(s => ({ ...s, pendingIntervention: true, interventionDelayRemaining: 3 }));
    }, []);

    useEffect(() => {
        if (!useWorker) return;
        if (!workerRef.current) workerRef.current = new Worker("worker.js");
        const worker = workerRef.current;
        worker.onmessage = (e) => { if (!e.data.type) setState(e.data); };
        return () => { worker.terminate(); workerRef.current = null; };
    }, [useWorker]);

    useEffect(() => {
        if (!running || useWorker) return;
        intervalRef.current = setInterval(() => {
            setState(prev => {
                const next = runTick(prev, cfg);
                if (next.tick >= cfg.ticks) { setRunning(false); setFinished(true); clearInterval(intervalRef.current); }
                return next;
            });
        }, 120);
        return () => clearInterval(intervalRef.current);
    }, [running, cfg, useWorker]);

    useEffect(() => {
        if (!running || !useWorker || !workerRef.current) return;
        const worker = workerRef.current;
        intervalRef.current = setInterval(() => {
            setState(prev => {
                if (prev.tick >= cfg.ticks) { setRunning(false); setFinished(true); clearInterval(intervalRef.current); return prev; }
                worker.postMessage({ state: prev, cfg, steps: 5 });
                return prev;
            });
        }, 120);
        return () => clearInterval(intervalRef.current);
    }, [running, cfg, useWorker]);

    const avgBaseHealth = state.history.baseHealth.at(-1) ?? 0.5;
    const avgAinoHealth = state.history.ainoHealth.at(-1) ?? 0.5;

    const modeColor =
        state.mode === "Normal"   ? "#22c55e" :
        state.mode === "Tension"  ? "#f59e0b" :
        state.mode === "Cooldown" ? "#60a5fa" :
        state.mode === "Recovery" ? "#a78bfa" :
        "#ef4444";

    const markers         = state.history.interventionMarkers || [];
    const recoveryMarkers = state.history.recoveryHealthMarkers || [];
    const canIntervene    = running && !state.pendingIntervention
        && (state.mode === "Tension" || state.mode === "Crisis");
    const shockLabel = { 1: "Low", 2: "Mid", 3: "High" };

    return (
        <div className="min-h-screen p-4 font-mono text-sm">
        <div className="max-w-5xl mx-auto">

        <h1 className="text-lg font-bold text-white mb-2">AïnO Governance Simulation</h1>

        {/* ── Controls ── */}
        <div className="flex flex-wrap gap-2 mb-4 items-center">
            <button onClick={() => setRunning(r => !r)} disabled={finished}
                className="px-4 py-1.5 rounded text-xs font-bold bg-blue-700 hover:bg-blue-600 disabled:opacity-40">
                {running ? "⏸ Pause" : finished ? "✓ Done" : "▶ Run"}
            </button>
            <button onClick={reset}
                className="px-4 py-1.5 rounded text-xs font-bold bg-gray-700 hover:bg-gray-600">
                ↺ Reset
            </button>

            {/* Shock intensity */}
            <div className="flex items-center gap-1 text-xs">
                <span className="text-gray-400">Shock:</span>
                {[1, 2, 3].map(lvl => (
                    <button key={lvl} onClick={() => setCfg(c => ({ ...c, shockIntensity: lvl }))}
                        className={`px-2 py-1 rounded font-bold border ${
                            cfg.shockIntensity === lvl
                                ? lvl === 1 ? "bg-yellow-700 border-yellow-500 text-white"
                                : lvl === 2 ? "bg-orange-700 border-orange-500 text-white"
                                : "bg-red-800 border-red-500 text-white"
                                : "bg-gray-800 border-gray-600 text-gray-400"
                        }`}>{lvl} {shockLabel[lvl]}</button>
                ))}
            </div>

            <button onClick={triggerShock} disabled={!running}
                className="px-4 py-1.5 rounded text-xs font-bold bg-red-800 hover:bg-red-700 disabled:opacity-40">
                ⚡ Shock
            </button>
            <button onClick={triggerIntervention} disabled={!canIntervene}
                className="px-4 py-1.5 rounded text-xs font-bold bg-purple-700 hover:bg-purple-600 disabled:opacity-40">
                🛠 Intervention
            </button>
            <button onClick={() => setShowMonteCarlo(v => !v)}
                className="px-4 py-1.5 rounded text-xs font-bold bg-teal-700 hover:bg-teal-600">
                🎲 Monte Carlo
            </button>

            <label className="flex items-center gap-1 text-xs text-gray-400 ml-2">
                <input type="checkbox" checked={useWorker} onChange={e => setUseWorker(e.target.checked)} />
                WebWorker
            </label>

            <div className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-gray-400">Day: {state.tick}/{cfg.ticks}</span>
                <div className="w-32 h-2 bg-gray-800 rounded overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all"
                        style={{ width: `${(state.tick / cfg.ticks) * 100}%` }} />
                </div>
            </div>
        </div>

        {/* ── Mode + Status bar ── */}
        <div className="flex flex-wrap items-center gap-3 mb-4 p-2 rounded bg-gray-900 border border-gray-800">
            <span className="text-xs text-gray-400">AïnO Mode:</span>
            <span className="font-bold text-sm" style={{ color: modeColor }}>{state.mode}</span>
            {state.shockActive && <span className="text-red-400 text-xs animate-pulse">⚡ SHOCK L{cfg.shockIntensity} ({state.shockDaysRemaining}d left)</span>}
            {state.pendingIntervention && <span className="text-purple-400 text-xs animate-pulse">🛠 Intervention in {state.interventionDelayRemaining}d…</span>}
            {state.mode === "Cooldown" && state.cooldownRemaining > 0 && <span className="text-blue-400 text-xs">❄ Cooldown: {state.cooldownRemaining}d left</span>}
            {state.graceRemaining > 0 && <span className="text-green-400 text-xs">🛡 Grace: {state.graceRemaining}d (Crisis blocked)</span>}
            {state.mode === "Crisis" && <span className="text-red-400 text-xs">🔥 Crisis day {state.crisisDayCount}/{cfg.autoCrisisDaysForRecovery}</span>}
            {(state.mode === "Tension" || state.mode === "Crisis") && !state.pendingIntervention && <span className="text-purple-300 text-xs">← Intervention available</span>}
            <span className="ml-auto text-xs text-gray-500">
                Capture Risk:{" "}
                <span className={state.captureRisk > 0.5 ? "text-red-400" : "text-green-400"}>
                    {(state.captureRisk * 100).toFixed(0)}%
                </span>
            </span>
        </div>

        {/* ── Parameter sliders ── */}
        <div className="mb-4 grid grid-cols-3 gap-4 text-xs bg-gray-900 p-3 rounded border border-gray-800">
            <div>
                <div className="font-bold text-gray-300 mb-1">Simulation</div>
                <label className="block mb-1">Days: {cfg.ticks}
                    <input type="range" min="60" max="720" step="30" value={cfg.ticks}
                        onChange={e => setCfg(c => ({ ...c, ticks: Number(e.target.value) }))} className="w-full" />
                </label>
                <label className="block mb-1">Shock Duration (days): {cfg.shockDurationDays}
                    <input type="range" min="1" max="30" step="1" value={cfg.shockDurationDays}
                        onChange={e => setCfg(c => ({ ...c, shockDurationDays: Number(e.target.value) }))} className="w-full" />
                </label>
                <label className="block mb-1">Gaming Rate: {cfg.gamingRate.toFixed(3)}
                    <input type="range" min="0.005" max="0.05" step="0.005" value={cfg.gamingRate}
                        onChange={e => setCfg(c => ({ ...c, gamingRate: Number(e.target.value) }))} className="w-full" />
                </label>
                <label className="block mb-1">Shadow Noise: {cfg.shadowNoise.toFixed(3)}
                    <input type="range" min="0.005" max="0.05" step="0.005" value={cfg.shadowNoise}
                        onChange={e => setCfg(c => ({ ...c, shadowNoise: Number(e.target.value) }))} className="w-full" />
                </label>
                <label className="block mb-1">Auto-Recovery after Crisis (days): {cfg.autoCrisisDaysForRecovery}
                    <input type="range" min="5" max="60" step="5" value={cfg.autoCrisisDaysForRecovery}
                        onChange={e => setCfg(c => ({ ...c, autoCrisisDaysForRecovery: Number(e.target.value) }))} className="w-full" />
                </label>
                <label className="block mb-1">Cooldown Duration (days): {cfg.cooldownDays}
                    <input type="range" min="5" max="30" step="5" value={cfg.cooldownDays}
                        onChange={e => setCfg(c => ({ ...c, cooldownDays: Number(e.target.value) }))} className="w-full" />
                </label>
            </div>

            <div>
                <div className="font-bold text-gray-300 mb-1">Thresholds</div>
                <label className="block mb-1">Tension Divergence: {cfg.thresholds.tension.toFixed(2)}
                    <input type="range" min="0.1" max="0.5" step="0.05" value={cfg.thresholds.tension}
                        onChange={e => setCfg(c => ({ ...c, thresholds: { ...c.thresholds, tension: Number(e.target.value) } }))} className="w-full" />
                </label>
                <label className="block mb-1">Crisis Divergence: {cfg.thresholds.crisis.toFixed(2)}
                    <input type="range" min="0.3" max="0.8" step="0.05" value={cfg.thresholds.crisis}
                        onChange={e => setCfg(c => ({ ...c, thresholds: { ...c.thresholds, crisis: Number(e.target.value) } }))} className="w-full" />
                </label>

                <div className="font-bold text-gray-300 mb-1 mt-3">Mode Decay</div>
                <label className="block mb-1">Decay Normal: {cfg.gamingDecay.Normal.toFixed(3)}
                    <input type="range" min="0.0" max="0.05" step="0.005" value={cfg.gamingDecay.Normal}
                        onChange={e => setCfg(c => ({ ...c, gamingDecay: { ...c.gamingDecay, Normal: Number(e.target.value) } }))} className="w-full" />
                </label>
                <label className="block mb-1">Decay Tension: {cfg.gamingDecay.Tension.toFixed(3)}
                    <input type="range" min="0.0" max="0.05" step="0.005" value={cfg.gamingDecay.Tension}
                        onChange={e => setCfg(c => ({ ...c, gamingDecay: { ...c.gamingDecay, Tension: Number(e.target.value) } }))} className="w-full" />
                </label>
                <label className="block mb-1">Decay Crisis: {cfg.gamingDecay.Crisis.toFixed(3)}
                    <input type="range" min="0.0" max="0.05" step="0.005" value={cfg.gamingDecay.Crisis}
                        onChange={e => setCfg(c => ({ ...c, gamingDecay: { ...c.gamingDecay, Crisis: Number(e.target.value) } }))} className="w-full" />
                </label>
            </div>

            {/* ── Random Seed column ── */}
            <div>
                <div className="font-bold text-gray-300 mb-1">🎲 Random Seed</div>
                <label className="flex items-center gap-2 mb-2 text-xs">
                    <input type="checkbox" checked={cfg.useRandomSeed}
                        onChange={e => setCfg(c => ({ ...c, useRandomSeed: e.target.checked }))} />
                    <span className={cfg.useRandomSeed ? "text-green-400" : "text-gray-500"}>
                        {cfg.useRandomSeed ? "Deterministic (seeded)" : "Non-deterministic"}
                    </span>
                </label>
                <label className="block mb-1 text-gray-400">
                    Seed value: <span className="text-white font-bold">{cfg.randomSeed}</span>
                    <input type="range" min="0" max="9999" step="1" value={cfg.randomSeed}
                        disabled={!cfg.useRandomSeed}
                        onChange={e => setCfg(c => ({ ...c, randomSeed: Number(e.target.value) }))}
                        className="w-full mt-0.5" />
                </label>
                <div className="text-gray-500 text-xs leading-relaxed mt-2">
                    Same seed → identical run every time.<br />
                    Useful for presentations, comparisons, and reproducible analysis.<br />
                    Monte Carlo uses seed+i for run i.
                </div>
                <div className="mt-3 flex gap-1 flex-wrap">
                    {[0, 42, 137, 1337, 9999].map(s => (
                        <button key={s}
                            onClick={() => setCfg(c => ({ ...c, randomSeed: s, useRandomSeed: true }))}
                            className={`px-2 py-0.5 rounded text-xs border ${cfg.randomSeed === s && cfg.useRandomSeed ? "bg-green-800 border-green-500 text-white" : "bg-gray-800 border-gray-600 text-gray-400"}`}>
                            {s}
                        </button>
                    ))}
                </div>
            </div>
        </div>

        {/* ── Monte Carlo Panel ── */}
        {showMonteCarlo && (
            <MonteCarloPanel cfg={cfg} onClose={() => setShowMonteCarlo(false)} />
        )}

        {/* ── Two orgs ── */}
        <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="bg-gray-900 rounded p-3 border border-gray-800">
                <div className="text-xs font-bold text-gray-300 mb-1">
                    📊 Baseline (KPI-only)
                    {state.baselineMode === "Cooldown" && <span className="ml-2 text-blue-400 font-normal">❄ Cooldown ({state.baselineCooldownRemaining}d)</span>}
                </div>
                {state.baselineDepts.map(d => (
                    <div key={d.name} className="mb-2">
                        <div className="flex justify-between text-xs mb-0.5">
                            <span className="text-gray-400">{d.name}</span>
                            <span className="text-gray-500">
                                KPI <span className="text-yellow-400">{(d.kpi * 100).toFixed(0)}</span>{" "}
                                | Real <span className="text-blue-400">{(d.reality * 100).toFixed(0)}</span>{" "}
                                | Δ <span className="text-red-400">{((d.kpi - d.reality) * 100).toFixed(0)}</span>
                            </span>
                        </div>
                        <div className="relative h-2 bg-gray-800 rounded overflow-hidden">
                            <div className="absolute h-full bg-blue-600 rounded" style={{ width: `${d.reality * 100}%` }} />
                            <div className="absolute h-full bg-yellow-500 opacity-70 rounded" style={{ width: `${d.kpi * 100}%` }} />
                        </div>
                    </div>
                ))}
                <div className="mt-2 text-xs">
                    Org Health:{" "}
                    <span className="font-bold" style={{ color: `hsl(${avgBaseHealth * 120},70%,55%)` }}>
                        {(avgBaseHealth * 100).toFixed(0)}%
                    </span>
                </div>
            </div>

            <div className="bg-gray-900 rounded p-3 border border-gray-800">
                <div className="text-xs font-bold text-gray-300 mb-1">
                    🔷 AïnO (Shadow + Mode)
                    {state.mode === "Cooldown" && <span className="ml-2 text-blue-400 font-normal">❄ Cooldown ({state.cooldownRemaining}d)</span>}
                </div>
                {state.ainoDepts.map(d => (
                    <div key={d.name} className="mb-2">
                        <div className="flex justify-between text-xs mb-0.5">
                            <span className="text-gray-400">{d.name}</span>
                            <span className="text-gray-500">
                                KPI <span className="text-yellow-400">{(d.kpi * 100).toFixed(0)}</span>{" "}
                                | Shadow <span className="text-purple-400">{(d.shadowMetric * 100).toFixed(0)}</span>{" "}
                                | Δ <span className="text-red-400">{((d.kpi - d.shadowMetric) * 100).toFixed(0)}</span>
                            </span>
                        </div>
                        <div className="relative h-2 bg-gray-800 rounded overflow-hidden">
                            <div className="absolute h-full bg-purple-600 rounded" style={{ width: `${d.shadowMetric * 100}%` }} />
                            <div className="absolute h-full bg-yellow-500 opacity-70 rounded" style={{ width: `${d.kpi * 100}%` }} />
                        </div>
                    </div>
                ))}
                <div className="mt-2 text-xs">
                    Org Health:{" "}
                    <span className="font-bold" style={{ color: `hsl(${avgAinoHealth * 120},70%,55%)` }}>
                        {(avgAinoHealth * 100).toFixed(0)}%
                    </span>
                </div>
            </div>
        </div>

        {/* ── Charts ── */}
        <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="bg-gray-900 rounded p-3 border border-gray-800">
                <div className="text-xs text-gray-500 mb-1">
                    🔴 Red lines = interventions/auto-recovery &nbsp;|&nbsp; 🟡🟣 Dots = org health at recovery start
                </div>
                <MiniChart data={state.history.baseHealth} color="#f59e0b" label="Baseline Org Health"
                    interventionMarkers={markers} recoveryHealthMarkers={recoveryMarkers} showRecoveryDots={true} />
                <MiniChart data={state.history.ainoHealth} color="#a78bfa" label="AïnO Org Health"
                    interventionMarkers={markers} recoveryHealthMarkers={recoveryMarkers} showRecoveryDots={true} />
            </div>
            <div className="bg-gray-900 rounded p-3 border border-gray-800">
                <MiniChart data={state.history.divergence} color="#f87171" label="AïnO KPI–Shadow Divergence"
                    interventionMarkers={markers} />
                <MiniChart data={state.history.mode} color="#34d399"
                    label="Mode Intensity (0.2=Normal 0.35=Cooldown 0.6=Tension 1=Crisis)"
                    interventionMarkers={markers} />
            </div>
        </div>

        {/* ── Governance Dashboard (always visible, activates on finish) ── */}
        <GovernanceDashboard state={state} cfg={cfg} finished={finished} />

        {/* ── Result ── */}
        {finished && (
            <div className="bg-gray-900 rounded p-4 border border-gray-700">
                <div className="text-sm font-bold text-white mb-2">📋 Simulation Result</div>
                <div className="grid grid-cols-3 gap-4 text-xs mb-3">
                    <div>
                        <div className="text-gray-400 mb-1">Baseline final health</div>
                        <div className="text-2xl font-bold text-yellow-400">{(avgBaseHealth * 100).toFixed(0)}%</div>
                    </div>
                    <div>
                        <div className="text-gray-400 mb-1">AïnO final health</div>
                        <div className="text-2xl font-bold text-purple-400">{(avgAinoHealth * 100).toFixed(0)}%</div>
                    </div>
                    <div>
                        <div className="text-gray-400 mb-1">Shadow capture risk</div>
                        <div className="text-2xl font-bold text-red-400">{(state.captureRisk * 100).toFixed(0)}%</div>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-xs mb-3">
                    <div>
                        <div className="text-gray-400 mb-1">Crisis events</div>
                        <div className="text-xl font-bold text-red-400">{state.crisisEventCount}</div>
                    </div>
                    <div>
                        <div className="text-gray-400 mb-1">Interventions / auto-recoveries</div>
                        <div className="text-xl font-bold text-purple-400">{markers.length}</div>
                        {markers.length > 0 && <div className="text-gray-500 mt-0.5">Days: {markers.join(", ")}</div>}
                    </div>
                </div>
                {recoveryMarkers.length > 0 && (
                    <div className="text-xs mb-3">
                        <div className="text-gray-400 mb-1">Org health at each recovery start:</div>
                        <table className="text-xs border-collapse">
                            <thead>
                                <tr>
                                    <th className="text-gray-500 pr-4 text-left">Day</th>
                                    <th className="text-yellow-400 pr-4 text-left">Baseline</th>
                                    <th className="text-purple-400 text-left">AïnO</th>
                                </tr>
                            </thead>
                            <tbody>
                                {recoveryMarkers.map((m, i) => (
                                    <tr key={i}>
                                        <td className="text-gray-400 pr-4">{m.tick}</td>
                                        <td className="text-yellow-400 pr-4">{(m.baseHealth * 100).toFixed(0)}%</td>
                                        <td className="text-purple-400">{(m.ainoHealth * 100).toFixed(0)}%</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <div className="text-xs text-gray-400">
                    Both orgs share the same reality. Health differences reflect governance quality only.
                </div>
            </div>
        )}

        </div>
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
