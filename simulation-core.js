// --- Config ---
const DEPT_NAMES = ["Sales", "Ops", "Finance", "Product"];
const MODES = { NORMAL: "Normal", TENSION: "Tension", CRISIS: "Crisis", RECOVERY: "Recovery", COOLDOWN: "Cooldown" };

// --- Helpers ---
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

export const DEFAULT_CONFIG = {
  ticks: 720,
  gamingRate: 0.02,
  gamingDecay: { Normal: 0.01, Tension: 0.02, Crisis: 0.03 },
  shadowNoise: 0.02,
  thresholds: {
    tension: 0.25,
    crisis: 0.50,
    reEscalation: 2,
    latency: 14
  },
  shockDurationMs: 150,
  autoCrisisDaysForRecovery: 30,
  cooldownDays: 15
};

// --- Department init ---
export function initDept(name) {
  return {
    name,
    kpi: 0.5,
    reality: 0.5,
    gaming: 0,
    shadowMetric: 0.5,
    latency: 0,
    reEscalations: 0
  };
}

// --- Baseline step ---
export function stepBaselineDept(dept, cfg, shock) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);
  const gamingPressure = 0.015 + dept.gaming * 0.01;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
  const newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);
  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

// --- AïnO step ---
// mode: "Normal" | "Tension" | "Crisis" | "Recovery" | "Cooldown"
export function stepAinoDept(dept, cfg, shock, mode) {
  // Reality always drifts; shock causes a sharp drop
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  // Shadow: during shock it LAGS (stays near previous value) so divergence spikes.
  // During Cooldown/Recovery, shadow slowly converges toward reality (healing).
  let newShadow;
  if (shock) {
    // Shadow lags: tiny noise only, does NOT follow reality drop
    newShadow = clamp(dept.shadowMetric + rand(-0.01, 0.01), 0, 1);
  } else if (mode === "Cooldown" || mode === "Recovery") {
    // Actively converge shadow toward reality (trust rebuilding)
    const convergenceRate = 0.05;
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * convergenceRate + rand(-0.005, 0.005), 0, 1);
  } else {
    // Normal tracking with noise
    newShadow = clamp(newReality + rand(-cfg.shadowNoise, cfg.shadowNoise), 0, 1);
  }

  // --- Cooldown mode ---
  if (mode === "Cooldown") {
    const newGaming = clamp(dept.gaming * 0.96, 0, 1);   // gaming decays faster
    // KPI slowly aligns toward reality (no more gaming pressure)
    const newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.03 + rand(-0.005, 0.005), 0, 1);
    return {
      ...dept,
      reality: newReality,
      kpi: newKpi,
      gaming: newGaming,
      shadowMetric: newShadow,
      latency: Math.max(0, dept.latency - 1),       // latency drains
      reEscalations: Math.max(0, dept.reEscalations - 0.2)  // re-escalations drain
    };
  }

  // --- Recovery mode (1 tick transition) ---
  if (mode === "Recovery") {
    const newGaming = clamp(dept.gaming * 0.90, 0, 1);
    const newKpi = clamp(dept.kpi + rand(-0.005, 0.005), 0, 1);
    return {
      ...dept,
      reality: newReality,
      kpi: newKpi,
      gaming: newGaming,
      shadowMetric: newShadow,
      latency: 0,
      reEscalations: 0
    };
  }

  // --- Normal / Tension / Crisis ---
  const modeFactors = {
    Normal:  { pressure: 1.0, decay: cfg.gamingDecay.Normal },
    Tension: { pressure: 0.6, decay: cfg.gamingDecay.Tension },
    Crisis:  { pressure: 0.3, decay: cfg.gamingDecay.Crisis }
  };
  const f = modeFactors[mode] || modeFactors.Normal;

  const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
  const newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01), 0, 1);
  const newGaming = clamp(dept.gaming + cfg.gamingRate - f.decay, 0, 1);

  // Latency & re-escalations
  const divergence = Math.abs(newKpi - newShadow);
  let newLatency = dept.latency + 1;
  let newReEsc = dept.reEscalations;

  if (divergence > cfg.thresholds.tension) {
    if (newLatency > cfg.thresholds.latency) {
      newReEsc = newReEsc + 1;
      newLatency = 0;
    }
  } else {
    // Divergence is low: drain latency and slowly drain re-escalations
    newLatency = Math.max(0, newLatency - 2);
    newReEsc = Math.max(0, newReEsc - 0.05);
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

// --- Mode logic (only for Normal/Tension/Crisis) ---
export function computeMode(depts, cfg) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) / depts.length;
  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));

  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation)
    return MODES.CRISIS;
  if (avgDiv >= cfg.thresholds.tension)
    return MODES.TENSION;
  return MODES.NORMAL;
}

// --- Org health ---
export function computeOrgHealth(depts) {
  const avgDiv = depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

// --- Apply recovery effects to departments ---
export function applyRecoveryToDepts(depts) {
  return depts.map(d => ({
    ...d,
    gaming: d.gaming * 0.5,
    reEscalations: 0,
    latency: 0
  }));
}

// --- Initial state ---
export function createInitialState() {
  return {
    tick: 0,
    baselineDepts: DEPT_NAMES.map(initDept),
    ainoDepts: DEPT_NAMES.map(initDept),
    mode: MODES.NORMAL,
    captureRisk: 0,
    shockActive: false,
    crisisDayCount: 0,
    cooldownRemaining: 0,
    crisisEventCount: 0,
    pendingIntervention: false,
    interventionDelayRemaining: 0,
    history: {
      baseHealth: [],
      ainoHealth: [],
      divergence: [],
      mode: [],
      interventionMarkers: []
    },
    shadowNoise: DEFAULT_CONFIG.shadowNoise
  };
}

// --- Tick ---
export function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  const shock = state.shockActive;
  let currentMode = state.mode;
  let crisisDayCount = state.crisisDayCount || 0;
  let cooldownRemaining = state.cooldownRemaining || 0;
  let crisisEventCount = state.crisisEventCount || 0;
  let pendingIntervention = state.pendingIntervention || false;
  let interventionDelayRemaining = state.interventionDelayRemaining || 0;
  let shadowNoise = state.shadowNoise !== undefined ? state.shadowNoise : cfg.shadowNoise;
  let interventionMarkers = [...(state.history.interventionMarkers || [])];
  let recoveryTriggeredThisTick = false;

  // ── 1. Pending intervention countdown ──
  if (pendingIntervention && interventionDelayRemaining > 0) {
    interventionDelayRemaining--;
    if (interventionDelayRemaining === 0) {
      pendingIntervention = false;
      recoveryTriggeredThisTick = true;
    }
  }

  // ── 2. Auto-recovery: Crisis held for N days ──
  if (currentMode === "Crisis") {
    crisisDayCount++;
    if (crisisDayCount >= (cfg.autoCrisisDaysForRecovery || 30)) {
      recoveryTriggeredThisTick = true;
      crisisDayCount = 0;
    }
  } else if (currentMode !== "Recovery" && currentMode !== "Cooldown") {
    crisisDayCount = 0;
  }

  // ── 3. Step departments ──
  let newBaseline = state.baselineDepts.map(d => stepBaselineDept(d, cfg, shock));
  let newAino;

  if (recoveryTriggeredThisTick) {
    // Apply instant recovery effects, then step in Recovery mode
    newAino = applyRecoveryToDepts(state.ainoDepts);
    shadowNoise = shadowNoise * 0.8;
    crisisDayCount = 0;
    cooldownRemaining = cfg.cooldownDays || 15;
    interventionMarkers = [...interventionMarkers, state.tick];
    // Step in Recovery mode (1 tick)
    newAino = newAino.map(d => stepAinoDept(d, cfg, shock, "Recovery"));
    currentMode = "Cooldown";  // immediately enter cooldown next tick

  } else if (currentMode === "Cooldown") {
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, "Cooldown"));
    cooldownRemaining = Math.max(0, cooldownRemaining - 1);
    if (cooldownRemaining === 0) {
      currentMode = "Normal";
    }

  } else {
    // Normal / Tension / Crisis
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, currentMode));
  }

  // ── 4. Compute new mode (only outside Cooldown) ──
  let newMode;
  if (currentMode === "Cooldown") {
    newMode = "Cooldown";
  } else {
    newMode = computeMode(newAino, cfg);
    // Track crisis events: entering crisis from non-crisis
    if (newMode === "Crisis" && state.mode !== "Crisis" && state.mode !== "Cooldown" && state.mode !== "Recovery") {
      crisisEventCount++;
    }
  }

  // ── 5. Capture risk ──
  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === "Crisis"   ?  0.010 :
    newMode === "Tension"  ?  0.005 :
    newMode === "Cooldown" ? -0.005 :
    newMode === "Recovery" ? -0.008 :
                             -0.003;
  const newCapture = clamp(state.captureRisk + riskDelta + maxReEsc * 0.001, 0, 1);

  // ── 6. History ──
  const bh = computeOrgHealth(newBaseline);
  const ah = computeOrgHealth(newAino);
  const div = newAino.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) / newAino.length;
  const modeIntensity =
    newMode === "Normal"   ? 0.2 :
    newMode === "Tension"  ? 0.6 :
    newMode === "Crisis"   ? 1.0 :
    newMode === "Recovery" ? 0.4 :
    newMode === "Cooldown" ? 0.3 : 0.2;

  return {
    ...state,
    tick: state.tick + 1,
    baselineDepts: newBaseline,
    ainoDepts: newAino,
    mode: newMode,
    captureRisk: newCapture,
    crisisDayCount,
    cooldownRemaining,
    crisisEventCount,
    pendingIntervention,
    interventionDelayRemaining,
    shadowNoise,
    history: {
      baseHealth: [...state.history.baseHealth, bh],
      ainoHealth: [...state.history.ainoHealth, ah],
      divergence: [...state.history.divergence, div],
      mode: [...state.history.mode, modeIntensity],
      interventionMarkers
    }
  };
}
