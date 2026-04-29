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
  return { name, kpi: 0.5, reality: 0.5, gaming: 0, shadowMetric: 0.5, latency: 0, reEscalations: 0 };
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
export function stepAinoDept(dept, cfg, shock, mode) {
  const realityDrift = rand(-0.03, 0.03) + (shock ? rand(-0.15, -0.05) : 0);
  const newReality = clamp(dept.reality + realityDrift, 0, 1);

  // Shadow behaviour by mode:
  // - shock: lags (stays near previous value) → divergence spike
  // - Cooldown/Recovery: fast convergence toward reality (trust rebuilding)
  // - Normal/Tension/Crisis: tracks reality with noise
  let newShadow;
  if (shock) {
    newShadow = clamp(dept.shadowMetric + rand(-0.01, 0.01), 0, 1);
  } else if (mode === "Cooldown" || mode === "Recovery") {
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.15 + rand(-0.005, 0.005), 0, 1);
  } else {
    newShadow = clamp(newReality + rand(-cfg.shadowNoise, cfg.shadowNoise), 0, 1);
  }

  // --- Cooldown mode ---
  if (mode === "Cooldown") {
    // KPI converges toward reality at 10%/tick (was 3%) — fast enough to close gap in 15 ticks
    const newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.10 + rand(-0.005, 0.005), 0, 1);
    // Gaming decays at 6%/tick
    const newGaming = clamp(dept.gaming * 0.94, 0, 1);
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

  // --- Recovery mode (1-tick instant reset) ---
  if (mode === "Recovery") {
    const newGaming = clamp(dept.gaming * 0.90, 0, 1);
    return {
      ...dept,
      reality: newReality,
      kpi: newReality + rand(-0.05, 0.05),   // snap KPI close to reality
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

  const divergence = Math.abs(newKpi - newShadow);
  let newLatency = dept.latency + 1;
  let newReEsc = dept.reEscalations;

  if (divergence > cfg.thresholds.tension) {
    if (newLatency > cfg.thresholds.latency) {
      newReEsc = newReEsc + 1;
      newLatency = 0;
    }
  } else {
    // Low divergence: drain latency and re-escalations
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

// --- Mode logic ---
export function computeMode(depts, cfg) {
  const avgDiv = depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) / depts.length;
  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));
  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation) return MODES.CRISIS;
  if (avgDiv >= cfg.thresholds.tension) return MODES.TENSION;
  return MODES.NORMAL;
}

// --- Org health ---
export function computeOrgHealth(depts) {
  const avgDiv = depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

// --- Apply recovery effects to departments ---
// Blend KPI toward reality (50/50), halve gaming, zero latency/reEsc
export function applyRecoveryToDepts(depts) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.5 + d.reality * 0.5,   // KEY FIX: blend KPI toward reality
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
    graceRemaining: 0,      // post-cooldown grace: blocks Crisis escalation
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
  let graceRemaining = state.graceRemaining || 0;
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
  } else if (currentMode !== "Cooldown") {
    crisisDayCount = 0;
  }

  // ── 3. Grace period countdown (post-cooldown) ──
  if (graceRemaining > 0 && currentMode !== "Cooldown") {
    graceRemaining = Math.max(0, graceRemaining - 1);
  }

  // ── 4. Step departments ──
  let newBaseline = state.baselineDepts.map(d => stepBaselineDept(d, cfg, shock));
  let newAino;

  if (recoveryTriggeredThisTick) {
    // Instant recovery: blend KPI, halve gaming, zero latency/reEsc
    newAino = applyRecoveryToDepts(state.ainoDepts);
    shadowNoise = shadowNoise * 0.8;
    crisisDayCount = 0;
    cooldownRemaining = cfg.cooldownDays || 15;
    // Grace period = 50% of cooldown duration (overlap)
    graceRemaining = Math.floor((cfg.cooldownDays || 15) / 2);
    interventionMarkers = [...interventionMarkers, state.tick];
    // Step in Recovery mode (snap tick)
    newAino = newAino.map(d => stepAinoDept(d, cfg, shock, "Recovery"));
    currentMode = "Cooldown";

  } else if (currentMode === "Cooldown") {
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, "Cooldown"));
    cooldownRemaining = Math.max(0, cooldownRemaining - 1);
    if (cooldownRemaining === 0) {
      currentMode = "Normal";
      // Grace period starts when cooldown ends (50% overlap)
      graceRemaining = Math.floor((cfg.cooldownDays || 15) / 2);
    }

  } else {
    newAino = state.ainoDepts.map(d => stepAinoDept(d, cfg, shock, currentMode));
  }

  // ── 5. Compute new mode ──
  let newMode;
  if (currentMode === "Cooldown") {
    newMode = "Cooldown";
  } else {
    newMode = computeMode(newAino, cfg);

    // Grace period: block escalation to Crisis (can still be Tension)
    if (graceRemaining > 0 && newMode === "Crisis") {
      newMode = "Tension";
    }

    // Track crisis events: entering crisis from non-crisis
    if (newMode === "Crisis" && state.mode !== "Crisis" && state.mode !== "Cooldown") {
      crisisEventCount++;
    }
  }

  // ── 6. Capture risk ──
  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === "Crisis"   ?  0.010 :
    newMode === "Tension"  ?  0.005 :
    newMode === "Cooldown" ? -0.005 :
                             -0.003;
  const newCapture = clamp(state.captureRisk + riskDelta + maxReEsc * 0.001, 0, 1);

  // ── 7. History ──
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
    graceRemaining,
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
