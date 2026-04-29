// simulation-core.js

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

// DEFAULT CONFIGURATION
export const DEFAULT_CONFIG = {
  ticks: 120,
  gamingRate: 0.02,
  shadowNoise: 0.05,
  gamingDecay: {
    tension: 0.3,
    crisis: 0.5
  },
  thresholds: {
    tension: 0.25,
    crisis: 0.45,
    latency: 10,
    reEscalation: 5
  }
};

// Helper function to create a department with randomized metrics
function createDept(name) {
  const reality = 50 + rand() * 30; // 50-80 range
  const kpi = reality + (rand() - 0.5) * 20; // KPI can deviate from reality
  const gaming = rand() * 10; // Initial gaming level 0-10
  return { name, reality, kpi, gaming };
}

// Create initial state for the simulation
export function createInitialState() {
  const deptNames = ['Finance', 'Operations', 'Compliance', 'R&D'];
  
  return {
    tick: 0,
    mode: 'Normal',
    baselineDepts: deptNames.map(createDept),
    ainoDepts: deptNames.map(name => ({
      ...createDept(name),
      shadow: 0,
      latency: 0,
      reEscalationCount: 0
    })),
    history: {
      health: [],
      divergence: [],
      captureRisk: []
    }
  };
}

export function stepBaselineDept(dept, cfg, shock) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.08, 0) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  const gamingPressure = 0.015 + dept.gaming * 0.01;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);

  const newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);

  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

export function stepAinoDept(dept, cfg, shock, mode) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.08, 0) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  const shadowNoise = rand(-cfg.shadowNoise, cfg.shadowNoise);
  const newShadow = clamp(newReality + shadowNoise, 0, 1);

  const modeFactors = {
    Normal: { pressure: 1.0, decay: cfg.gamingDecay.Normal },
    Tension: { pressure: 0.6, decay: cfg.gamingDecay.Tension },
    Crisis: { pressure: 0.3, decay: cfg.gamingDecay.Crisis }
  };
  const f = modeFactors[mode];

  const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);

  const newGaming = clamp(dept.gaming + cfg.gamingRate - f.decay, 0, 1);

  const divergence = Math.abs(newKpi - newShadow);
  let newLatency = dept.latency + 1;
  let newReEsc = dept.reEscalations;

  if (divergence > cfg.thresholds.tension) {
    if (newLatency > cfg.thresholds.latency) {
      newReEsc++;
      newLatency = 0;
    }
  } else {
    newLatency = 0;
  }

  return {
    ...dept,
    reality: newReality,
    kpi: newKpi,
    gaming: newGaming,
    shadowMetric: newShadow,
    latency: newLatency,
    reEscalations: newReEsc
  };
}

export function computeMode(depts, cfg) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    depts.length;

  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));

  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation)
    return "Crisis";

  if (avgDiv >= cfg.thresholds.tension)
    return "Tension";

  return "Normal";
}

export function computeOrgHealth(depts) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

export function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  // hierarchy intervention
  if (state.forceResetToNormal) {
    return {
      ...state,
      mode: "Normal",
      forceResetToNormal: false,
      history: {
        ...state.history,
        interventions: [...state.history.interventions, state.tick],
        mode: [...state.history.mode, 0.2] // Normal intensity
      },
      tick: state.tick + 1
    };
  }

  const shock = state.shockActive;

  const newBaseline = state.baselineDepts.map(d =>
    stepBaselineDept(d, cfg, shock)
  );
  const newAino = state.ainoDepts.map(d =>
    stepAinoDept(d, cfg, shock, state.mode)
  );

  const newMode = computeMode(newAino, cfg);

  const crisisCount =
    newMode === "Crisis"
      ? state.crisisCount + 1
      : state.crisisCount;

  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === "Crisis" ? 0.01 :
    newMode === "Tension" ? 0.005 :
    -0.003;

  const newCapture = clamp(
    state.captureRisk + riskDelta + maxReEsc * 0.001,
    0,
    1
  );

  const bh = computeOrgHealth(newBaseline);
  const ah = computeOrgHealth(newAino);
  const div =
    newAino.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    newAino.length;

  const modeIntensity =
    newMode === "Normal" ? 0.2 :
    newMode === "Tension" ? 0.6 : 1.0;

  return {
    ...state,
    tick: state.tick + 1,
    baselineDepts: newBaseline,
    ainoDepts: newAino,
    mode: newMode,
    crisisCount,
    captureRisk: newCapture,
    history: {
      baseHealth: [...state.history.baseHealth, bh],
      ainoHealth: [...state.history.ainoHealth, ah],
      divergence: [...state.history.divergence, div],
      mode: [...state.history.mode, modeIntensity],
      interventions: [...state.history.interventions]
    }
  };
}
