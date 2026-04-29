import {
  DEFAULT_CONFIG,
  createInitialState,
  runTick
} from "./simulation-core.js";

const { useState, useEffect, useRef } = React;

function App() {

  // -------------------------------------------------------------
  // INITIAL STATE
  // -------------------------------------------------------------
  const [state, setState] = useState(() => {
    const init = createInitialState();
    return {
      ...init,
      crisisCount: 0,
      forceResetToNormal: false,
      history: {
        baseHealth: [],
        ainoHealth: [],
        divergence: [],
        mode: [],
        interventions: []
      }
    };
  });

  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const workerRef = useRef(null);

  // -------------------------------------------------------------
  // START WORKER
  // -------------------------------------------------------------
  useEffect(() => {
    workerRef.current = new Worker("worker.js");

    workerRef.current.onmessage = (e) => {
      setState(e.data);
    };

    return () => workerRef.current.terminate();
  }, []);

  // -------------------------------------------------------------
  // RUN SIMULATION
  // -------------------------------------------------------------
  function runSimulation() {
    if (!workerRef.current) return;

    workerRef.current.postMessage({
      state,
      cfg: config,
      steps: 1
    });
  }

  // -------------------------------------------------------------
  // POLITICAL SHOCK
  // -------------------------------------------------------------
  function toggleShock() {
    setState(prev => ({
      ...prev,
      shockActive: !prev.shockActive
    }));
  }

  // -------------------------------------------------------------
  // HIERARCHY INTERVENTION
  // -------------------------------------------------------------
  function triggerHierarchyIntervention() {
    setState(prev => ({
      ...prev,
      forceResetToNormal: true
    }));
  }

  // -------------------------------------------------------------
  // UI
  // -------------------------------------------------------------
  return (
    <div className="p-4 space-y-4">

      <h1 className="text-xl font-bold">AïnO Governance Simulation</h1>

      <div className="flex gap-2">
        <button
          className="px-3 py-1 rounded bg-blue-600 text-white text-sm"
          onClick={runSimulation}
        >
          Run Tick
        </button>

        <button
          className="px-3 py-1 rounded bg-red-600 text-white text-sm"
          onClick={toggleShock}
        >
          Political Shock
        </button>

        <button
          className="px-3 py-1 rounded bg-amber-500 text-black text-sm"
          onClick={triggerHierarchyIntervention}
        >
          Hierarchy Intervention
        </button>
      </div>

      <div className="text-sm">
        <p>Tick: {state.tick}</p>
        <p>Mode: {state.mode}</p>
        <p>Crisis events: {state.crisisCount}</p>
        <p>Capture Risk: {(state.captureRisk * 100).toFixed(1)}%</p>
      </div>

      <MiniChart
        data={state.history.mode}
        color="#f97316"
        label="Mode Intensity"
        markers={state.history.interventions}
      />

    </div>
  );
}

// -------------------------------------------------------------
// MINICHART WITH INTERVENTION MARKERS
// -------------------------------------------------------------
function MiniChart({ data, color, label, markers = [] }) {
  if (!data || data.length === 0) return null;

  const max = Math.max(...data, 1);
  const points = data.map((v, i) => `${i},${max - v}`).join(" ");

  return (
    <div className="w-full">
      <p className="text-xs mb-1">{label}</p>
      <svg viewBox={`0 0 ${data.length} ${max}`} className="w-full h-24 bg-gray-800">

        <polyline
          fill="none"
          stroke={color}
          strokeWidth="0.5"
          points={points}
        />

        {markers.map((m, idx) => (
          <line
            key={idx}
            x1={m}
            x2={m}
            y1="0"
            y2={max}
            stroke="red"
            strokeWidth="0.5"
          />
        ))}
      </svg>
    </div>
  );
}

// -------------------------------------------------------------
// RENDER
// -------------------------------------------------------------
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
