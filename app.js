import {
    DEFAULT_CONFIG,
    createInitialState,
    runTick
} from "./simulation-core.js";

const { useState, useEffect, useRef, useCallback } = React;

// --- MiniChart with intervention markers (pure SVG) ---
function MiniChart({ data, color, label, height = 60, interventionMarkers = [], showMarkers = false }) {
    if (!data || data.length < 2) return null;
    const w = 260, h = height;
    const pts = data
        .map((v, i) => `${(i / (data.length - 1)) * w},${h - v * h}`)
        .join(" ");

    return (
        <div className="mb-1">
            <div className="text-xs text-gray-400 mb-0.5">{label}</div>
            <svg width={w} height={h} className="bg-gray-900 rounded" style={{overflow:'visible'}}>
                <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
                {showMarkers && interventionMarkers.map((tick, idx) => {
                    const x = data.length > 1 ? (tick / (data.length - 1)) * w : 0;
                    return (
                        <g key={idx}>
                            <line x1={x} y1={0} x2={x} y2={h} stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3,2" />
                            <text x={x+2} y={10} fill="#ef4444" fontSize="8">↓</text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

// --- Main App ---
function App() {
    const [cfg, setCfg] = useState(DEFAULT_CONFIG);
    const [state, setState] = useState(createInitialState());
    const [running, setRunning] = useState(false);
    const [finished, setFinished] = useState(false);
    const [useWorker, setUseWorker] = useState(false);

    const intervalRef = useRef(null);
    const workerRef = useRef(null);

    // Reset
    const reset = useCallback(() => {
        setRunning(false);
        setFinished(false);
        clearInterval(intervalRef.current);
        setState(createInitialState());
    }, []);

    // Shock
    const triggerShock = useCallback(() => {
        setState(s => ({ ...s, shockActive: true }));
        setTimeout(() => {
            setState(s => ({ ...s, shockActive: false }));
        }, cfg.shockDurationMs);
    }, [cfg.shockDurationMs]);

    // Intervention: triggers recovery after 3 days
    const triggerIntervention = useCallback(() => {
        setState(s => {
            // Only trigger if not already in recovery/cooldown/pending
            if (s.mode === "Recovery" || s.mode === "Cooldown" || s.pendingIntervention) return s;
            return {
                ...s,
                pendingIntervention: true,
                interventionDelayRemaining: 3
            };
        });
    }, []);

    // Worker setup
    useEffect(() => {
        if (!useWorker) return;
        if (!workerRef.current) {
            workerRef.current = new Worker("worker.js");
        }
        const worker = workerRef.current;
        worker.onmessage = (e) => { setState(e.data); };
        return () => { worker.terminate(); workerRef.current = null; };
    }, [useWorker]);

    // Tick loop (no worker)
    useEffect(() => {
        if (!running || useWorker) return;
        intervalRef.current = setInterval(() => {
            setState(prev => {
                const next = runTick(prev, cfg);
                if (next.tick >= cfg.ticks) {
                    setRunning(false);
                    setFinished(true);
                    clearInterval(intervalRef.current);
                }
                return next;
            });
        }, 120);
        return () => clearInterval(intervalRef.current);
    }, [running, cfg, useWorker]);

    // Tick loop (worker)
    useEffect(() => {
        if (!running || !useWorker || !workerRef.current) return;
        const worker = workerRef.current;
        intervalRef.current = setInterval(() => {
            setState(prev => {
                if (prev.tick >= cfg.ticks) {
                    setRunning(false);
                    setFinished(true);
                    clearInterval(intervalRef.current);
                    return prev;
                }
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
        state.mode === "Crisis"   ? "#ef4444" :
        state.mode === "Recovery" ? "#60a5fa" :
        state.mode === "Cooldown" ? "#a78bfa" : "#22c55e";

    const interventionMarkers = state.history.interventionMarkers || [];

    return (
        <div className="min-h-screen p-4 font-mono text-sm">
            <div className="max-w-5xl mx-auto">

                <h1 className="text-lg font-bold text-white mb-2">
                    AïnO Governance Simulation
                </h1>

                {/* Controls */}
                <div className="flex flex-wrap gap-2 mb-4 items-center">
                    <button
                        onClick={() => setRunning(r => !r)}
                        disabled={finished}
                        className="px-4 py-1.5 rounded text-xs font-bold bg-blue-700 hover:bg-blue-600 disabled:opacity-40"
                    >
                        {running ? "⏸ Pause" : finished ? "✓ Done" : "▶ Run"}
                    </button>

                    <button
                        onClick={reset}
                        className="px-4 py-1.5 rounded text-xs font-bold bg-gray-700 hover:bg-gray-600"
                    >
                        ↺ Reset
                    </button>

                    <button
                        onClick={triggerShock}
                        disabled={!running}
                        className="px-4 py-1.5 rounded text-xs font-bold bg-red-800 hover:bg-red-700 disabled:opacity-40"
                    >
                        ⚡ Political Shock
                    </button>

                    <button
                        onClick={triggerIntervention}
                        disabled={!running || state.mode === "Recovery" || state.mode === "Cooldown" || state.pendingIntervention}
                        className="px-4 py-1.5 rounded text-xs font-bold bg-orange-700 hover:bg-orange-600 disabled:opacity-40"
                        title="Triggers recovery mode after 3 days"
                    >
                        🛡 Intervention
                    </button>

                    <label className="flex items-center gap-1 text-xs text-gray-400 ml-4">
                        <input
                            type="checkbox"
                            checked={useWorker}
                            onChange={e => setUseWorker(e.target.checked)}
                        />
                        Use WebWorker
                    </label>

                    <div className="flex items-center gap-2 ml-auto">
                        <span className="text-xs text-gray-400">
                            Day: {state.tick}/{cfg.ticks}
                        </span>
                        <div className="w-32 h-2 bg-gray-800 rounded overflow-hidden">
                            <div
                                className="h-full bg-blue-500 transition-all"
                                style={{ width: `${(state.tick / cfg.ticks) * 100}%` }}
                            />
                        </div>
                    </div>
                </div>

                {/* Mode + Capture */}
                <div className="flex items-center gap-3 mb-4 p-2 rounded bg-gray-900 border border-gray-800">
                    <span className="text-xs text-gray-400">AïnO Mode:</span>
                    <span className="font-bold text-sm" style={{ color: modeColor }}>
                        {state.mode}
                    </span>

                    {state.shockActive && (
                        <span className="text-red-400 text-xs animate-pulse">⚡ SHOCK ACTIVE</span>
                    )}

                    {state.pendingIntervention && (
                        <span className="text-orange-400 text-xs animate-pulse">
                            🛡 Intervention in {state.interventionDelayRemaining} day(s)
                        </span>
                    )}

                    {state.mode === "Cooldown" && (
                        <span className="text-purple-400 text-xs">
                            ❄ Cooldown: {state.cooldownRemaining} day(s) left
                        </span>
                    )}

                    {state.mode === "Crisis" && (
                        <span className="text-red-400 text-xs">
                            🔥 Crisis day {state.crisisDayCount}/{cfg.autoCrisisDaysForRecovery}
                        </span>
                    )}

                    {(state.graceRemaining > 0) && state.mode !== "Cooldown" && (
                        <span className="text-teal-400 text-xs">
                            🛡 Grace: {state.graceRemaining} day(s) (Crisis blocked)
                        </span>
                    )}

                    <span className="ml-auto text-xs text-gray-500">
                        Shadow Capture Risk:{" "}
                        <span className={state.captureRisk > 0.5 ? "text-red-400" : "text-green-400"}>
                            {(state.captureRisk * 100).toFixed(0)}%
                        </span>
                    </span>
                </div>

                {/* Parameter sliders */}
                <div className="mb-4 grid grid-cols-3 gap-4 text-xs bg-gray-900 p-3 rounded border border-gray-800">
                    {/* Simulation */}
                    <div>
                        <div className="font-bold text-gray-300 mb-1">Simulation</div>

                        <label className="block mb-1">
                            Days: {cfg.ticks}
                            <input type="range" min="60" max="720" step="60" value={cfg.ticks}
                                onChange={e => setCfg(c => ({ ...c, ticks: Number(e.target.value) }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Gaming Rate: {cfg.gamingRate.toFixed(3)}
                            <input type="range" min="0.005" max="0.05" step="0.005" value={cfg.gamingRate}
                                onChange={e => setCfg(c => ({ ...c, gamingRate: Number(e.target.value) }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Shadow Noise: {cfg.shadowNoise.toFixed(3)}
                            <input type="range" min="0.005" max="0.05" step="0.005" value={cfg.shadowNoise}
                                onChange={e => setCfg(c => ({ ...c, shadowNoise: Number(e.target.value) }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Auto-Recovery after Crisis (days): {cfg.autoCrisisDaysForRecovery}
                            <input type="range" min="5" max="60" step="5" value={cfg.autoCrisisDaysForRecovery}
                                onChange={e => setCfg(c => ({ ...c, autoCrisisDaysForRecovery: Number(e.target.value) }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Cooldown Duration (days): {cfg.cooldownDays}
                            <input type="range" min="5" max="30" step="5" value={cfg.cooldownDays}
                                onChange={e => setCfg(c => ({ ...c, cooldownDays: Number(e.target.value) }))}
                                className="w-full" />
                        </label>
                    </div>

                    {/* Thresholds */}
                    <div>
                        <div className="font-bold text-gray-300 mb-1">Thresholds</div>

                        <label className="block mb-1">
                            Tension Divergence: {cfg.thresholds.tension.toFixed(2)}
                            <input type="range" min="0.1" max="0.5" step="0.05" value={cfg.thresholds.tension}
                                onChange={e => setCfg(c => ({ ...c, thresholds: { ...c.thresholds, tension: Number(e.target.value) } }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Crisis Divergence: {cfg.thresholds.crisis.toFixed(2)}
                            <input type="range" min="0.3" max="0.8" step="0.05" value={cfg.thresholds.crisis}
                                onChange={e => setCfg(c => ({ ...c, thresholds: { ...c.thresholds, crisis: Number(e.target.value) } }))}
                                className="w-full" />
                        </label>
                    </div>

                    {/* Mode decay */}
                    <div>
                        <div className="font-bold text-gray-300 mb-1">Mode Decay</div>

                        <label className="block mb-1">
                            Decay Normal: {cfg.gamingDecay.Normal.toFixed(3)}
                            <input type="range" min="0.0" max="0.05" step="0.005" value={cfg.gamingDecay.Normal}
                                onChange={e => setCfg(c => ({ ...c, gamingDecay: { ...c.gamingDecay, Normal: Number(e.target.value) } }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Decay Tension: {cfg.gamingDecay.Tension.toFixed(3)}
                            <input type="range" min="0.0" max="0.05" step="0.005" value={cfg.gamingDecay.Tension}
                                onChange={e => setCfg(c => ({ ...c, gamingDecay: { ...c.gamingDecay, Tension: Number(e.target.value) } }))}
                                className="w-full" />
                        </label>

                        <label className="block mb-1">
                            Decay Crisis: {cfg.gamingDecay.Crisis.toFixed(3)}
                            <input type="range" min="0.0" max="0.05" step="0.005" value={cfg.gamingDecay.Crisis}
                                onChange={e => setCfg(c => ({ ...c, gamingDecay: { ...c.gamingDecay, Crisis: Number(e.target.value) } }))}
                                className="w-full" />
                        </label>
                    </div>
                </div>

                {/* Two orgs */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                    {/* Baseline */}
                    <div className="bg-gray-900 rounded p-3 border border-gray-800">
                        <div className="text-xs font-bold text-gray-300 mb-2">📊 Baseline (KPI-only)</div>
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

                    {/* AïnO */}
                    <div className="bg-gray-900 rounded p-3 border border-gray-800">
                        <div className="text-xs font-bold text-gray-300 mb-2">🔷 AïnO (Shadow + Mode)</div>
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

                {/* Charts */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="bg-gray-900 rounded p-3 border border-gray-800">
                        <MiniChart data={state.history.baseHealth} color="#f59e0b" label="Baseline Org Health" />
                        <MiniChart data={state.history.ainoHealth} color="#a78bfa" label="AïnO Org Health" />
                    </div>

                    <div className="bg-gray-900 rounded p-3 border border-gray-800">
                        <MiniChart data={state.history.divergence} color="#f87171" label="AïnO KPI–Shadow Divergence" />
                        <MiniChart
                            data={state.history.mode}
                            color="#34d399"
                            label="Mode Intensity (▼ = Intervention)"
                            interventionMarkers={interventionMarkers}
                            showMarkers={true}
                        />
                        {interventionMarkers.length > 0 && (
                            <div className="text-xs text-red-400 mt-1">
                                🔴 Red lines = Recovery interventions ({interventionMarkers.length} total)
                            </div>
                        )}
                    </div>
                </div>

                {/* Result */}
                {finished && (
                    <div className="bg-gray-900 rounded p-4 border border-gray-700">
                        <div className="text-sm font-bold text-white mb-2">📋 Simulation Result</div>

                        <div className="grid grid-cols-4 gap-4 text-xs">
                            <div>
                                <div className="text-gray-400 mb-1">Baseline final health</div>
                                <div className="text-2xl font-bold text-yellow-400">
                                    {(avgBaseHealth * 100).toFixed(0)}%
                                </div>
                            </div>

                            <div>
                                <div className="text-gray-400 mb-1">AïnO final health</div>
                                <div className="text-2xl font-bold text-purple-400">
                                    {(avgAinoHealth * 100).toFixed(0)}%
                                </div>
                            </div>

                            <div>
                                <div className="text-gray-400 mb-1">Shadow capture risk</div>
                                <div className="text-2xl font-bold text-red-400">
                                    {(state.captureRisk * 100).toFixed(0)}%
                                </div>
                            </div>

                            <div>
                                <div className="text-gray-400 mb-1">Crisis events</div>
                                <div className="text-2xl font-bold text-orange-400">
                                    {state.crisisEventCount}
                                </div>
                            </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-4 text-xs text-gray-400">
                            <div>
                                <span className="text-gray-300 font-bold">Interventions triggered: </span>
                                {interventionMarkers.length}
                                {interventionMarkers.length > 0 && (
                                    <span className="ml-1">(days: {interventionMarkers.map(t => t+1).join(", ")})</span>
                                )}
                            </div>
                            <div>
                                <span className="text-gray-300 font-bold">Final mode: </span>
                                <span style={{ color: modeColor }}>{state.mode}</span>
                            </div>
                        </div>

                        <div className="mt-3 text-xs text-gray-400">
                            Interpretation: compare Baseline vs AïnO health and capture risk.
                            High AïnO health with moderate capture risk suggests effective oversight;
                            high capture risk with low health suggests oversight overload or failure.
                            Crisis events indicate how many times the system entered crisis mode.
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}

// Mount React
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
