// --- Config ---
const DEPT_NAMES = ["Sales", "Ops", "Finance", "Product"];
const MODES = {
  NORMAL: "Normal",
  TENSION: "Tension",
  CRISIS: "Crisis",
  RECOVERY: "Recovery",
  COOLDOWN: "Cooldown"
};

const SHOCK_PROFILES = {
  1: { realityDrift: [-0.05, -0.02], kpiDrop: [-0.04, -0.01], gamingSpike: 0.03, latencyBoost: 3,  shadowFreeze: true },
  2: { realityDrift: [-0.10, -0.04], kpiDrop: [-0.09, -0.03], gamingSpike: 0.07, latencyBoost: 6,  shadowFreeze: true },
  3: { realityDrift: [-0.18, -0.08], kpiDrop: [-0.18, -0.07], gamingSpike: 0.15, latencyBoost: 10, shadowFreeze: true }
};

// --- Seeded PRNG (mulberry32) ---
// Returns a stateless [0,1) float given a uint32 seed+counter.
// We thread a mutable `rngState` object through the simulation so
// every call to rand() advances it deterministically.
// makePRNG returns a plain serializable object {s: uint32}
// so it can safely pass through postMessage (structured clone).
function makePRNG(seed) {
  return { s: seed >>> 0 };
}

// Advance the PRNG state and return a [0,1) float (mulberry32).
// Mutates rng.s in-place so the sequence is deterministic across ticks.
function rngNext(rng) {
  if (!rng) return Math.random();
  rng.s = (rng.s + 0x6D2B79F5) >>> 0;
  let t = Math.imul(rng.s ^ (rng.s >>> 15), 1 | rng.s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function rand(lo, hi, rng) {
  return lo + rngNext(rng) * (hi - lo);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const DEFAULT_CONFIG = {
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
  shockDurationDays: 7,
  shockIntensity: 2,
  autoCrisisDaysForRecovery: 30,
  cooldownDays: 15,
  randomSeed: 42,          // default seed
  useRandomSeed: true      // when false → Math.random() (non-deterministic)
};

// --- Department init ---
function initDept(name) {
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

// --- Shared reality step ---
function stepSharedReality(reality, shock, shockProfile, rng) {
  const [dlo, dhi] = shock ? shockProfile.realityDrift : [-0.03, 0.03];
  return clamp(reality + rand(dlo, dhi, rng), 0, 1);
}

// --- Baseline step ---
function stepBaselineDept(dept, cfg, shock, shockProfile, baselineMode, sharedReality, rng) {
  const newReality = sharedReality;
  let newKpi, newGaming;

  if (baselineMode === "Recovery" || baselineMode === "Cooldown") {
    newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.05 + rand(-0.03, 0.03, rng), 0, 1);
    newGaming = clamp(dept.gaming * 0.97, 0, 1);
  } else {
    const gamingPressure = 0.015 + dept.gaming * 0.01;
    newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01, rng), 0, 1);
    newGaming = clamp(dept.gaming + cfg.gamingRate, 0, 1);

    if (shock) {
      const [klo, khi] = shockProfile.kpiDrop;
      newKpi = clamp(newKpi + rand(klo, khi, rng), 0, 1);
      newGaming = clamp(newGaming + shockProfile.gamingSpike * 0.5, 0, 1);
    }

    const gap = newKpi - newReality;
    if (gap > 0.3) {
      newKpi = clamp(newKpi - gap * 0.04 + rand(-0.02, 0.02, rng), 0, 1);
      newGaming = clamp(newGaming * 0.98, 0, 1);
    }
  }

  return { ...dept, reality: newReality, kpi: newKpi, gaming: newGaming };
}

// --- AïnO step ---
function stepAinoDept(dept, cfg, shock, shockProfile, mode, sharedReality, rng) {
  const newReality = sharedReality;
  let newShadow, newKpi, newGaming, newLatency, newReEsc;

  if (mode === "Recovery") {
    newKpi = clamp(newReality + rand(-0.05, 0.05, rng), 0, 1);
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.30 + rand(-0.01, 0.01, rng), 0, 1);
    newGaming = clamp(dept.gaming * 0.85, 0, 1);
    newLatency = 0;
    newReEsc = 0;
  } else if (mode === "Cooldown") {
    newKpi = clamp(dept.kpi + (newReality - dept.kpi) * 0.10 + rand(-0.01, 0.01, rng), 0, 1);
    newShadow = clamp(dept.shadowMetric + (newReality - dept.shadowMetric) * 0.15 + rand(-0.005, 0.005, rng), 0, 1);
    newGaming = clamp(dept.gaming * 0.94, 0, 1);
    newLatency = 0;
    newReEsc = 0;
  } else {
    if (shock) {
      newShadow = clamp(dept.shadowMetric + rand(-0.005, 0.005, rng), 0, 1);
      const [klo, khi] = shockProfile.kpiDrop;
      newKpi = clamp(dept.kpi + rand(klo, khi, rng), 0, 1);
      newGaming = clamp(dept.gaming + shockProfile.gamingSpike, 0, 1);
      newLatency = dept.latency + 1 + shockProfile.latencyBoost;
      newReEsc = dept.reEscalations;
      const divergence = Math.abs(newKpi - newShadow);
      if (divergence > cfg.thresholds.tension && newLatency > cfg.thresholds.latency) {
        newReEsc++;
        newLatency = 0;
      }
    } else {
      const shadowNoise = rand(-cfg.shadowNoise, cfg.shadowNoise, rng);
      newShadow = clamp(newReality + shadowNoise, 0, 1);

      const modeFactors = {
        Normal:  { pressure: 1.0, decay: cfg.gamingDecay.Normal },
        Tension: { pressure: 0.6, decay: cfg.gamingDecay.Tension },
        Crisis:  { pressure: 0.3, decay: cfg.gamingDecay.Crisis }
      };
      const f = modeFactors[mode] || modeFactors.Normal;

      const gamingPressure = 0.015 * f.pressure + dept.gaming * 0.005 * f.pressure;
      newKpi = clamp(dept.kpi + gamingPressure + rand(-0.01, 0.01, rng), 0, 1);
      newGaming = clamp(dept.gaming + cfg.gamingRate - f.decay, 0, 1);

      const divergence = Math.abs(newKpi - newShadow);
      newLatency = dept.latency + 1;
      newReEsc = dept.reEscalations;

      if (divergence > cfg.thresholds.tension) {
        if (newLatency > cfg.thresholds.latency) {
          newReEsc++;
          newLatency = 0;
        }
      } else {
        newLatency = Math.max(0, dept.latency - 2);
        newReEsc = Math.max(0, dept.reEscalations - 0.05);
      }
    }
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
function computeMode(depts, cfg) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    depts.length;
  const maxReEsc = Math.max(...depts.map(d => d.reEscalations));

  if (avgDiv >= cfg.thresholds.crisis || maxReEsc >= cfg.thresholds.reEscalation)
    return MODES.CRISIS;
  if (avgDiv >= cfg.thresholds.tension)
    return MODES.TENSION;
  return MODES.NORMAL;
}

// --- Org health ---
function computeOrgHealth(depts) {
  const avgDiv =
    depts.reduce((s, d) => s + Math.abs(d.kpi - d.reality), 0) / depts.length;
  const avgGaming = depts.reduce((s, d) => s + d.gaming, 0) / depts.length;
  return clamp(1 - avgDiv * 0.9 - avgGaming * 0.3, 0, 1);
}

// --- Apply recovery ---
function applyRecoveryToAinoDepts(depts, rng) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.5 + d.reality * 0.5,
    gaming: d.gaming * 0.50,
    shadowMetric: d.shadowMetric + (d.reality - d.shadowMetric) * 0.5,
    latency: 0,
    reEscalations: 0
  }));
}

function applyRecoveryToBaselineDepts(depts, rng) {
  return depts.map(d => ({
    ...d,
    kpi: d.kpi * 0.7 + d.reality * 0.3 + rand(-0.03, 0.03, rng),
    gaming: d.gaming * 0.75
  }));
}

// --- Initial state ---
function createInitialState(cfg) {
  const sharedReality = DEPT_NAMES.map(() => 0.5);
  // Create a fresh PRNG from seed (or null for Math.random)
  const rng = (cfg && cfg.useRandomSeed) ? makePRNG(cfg.randomSeed) : null;
  return {
    tick: 0,
    sharedReality,
    baselineDepts: DEPT_NAMES.map(initDept),
    ainoDepts: DEPT_NAMES.map(initDept),
    mode: MODES.NORMAL,
    baselineMode: MODES.NORMAL,
    captureRisk: 0,
    shockActive: false,
    shockDaysRemaining: 0,
    crisisDayCount: 0,
    cooldownRemaining: 0,
    baselineCooldownRemaining: 0,
    graceRemaining: 0,
    crisisEventCount: 0,
    pendingIntervention: false,
    interventionDelayRemaining: 0,
    rng,   // carried in state so it advances deterministically tick-by-tick
    history: {
      baseHealth: [],
      ainoHealth: [],
      divergence: [],
      mode: [],
      interventionMarkers: [],
      recoveryHealthMarkers: []
    }
  };
}

// --- Tick ---
function runTick(state, cfg) {
  if (state.tick >= cfg.ticks) return state;

  const shockProfile = SHOCK_PROFILES[cfg.shockIntensity] || SHOCK_PROFILES[2];
  const rng = state.rng; // may be null (non-deterministic)

  let shockActive = state.shockActive;
  let shockDaysRemaining = state.shockDaysRemaining;
  if (shockActive) {
    shockDaysRemaining--;
    if (shockDaysRemaining <= 0) {
      shockActive = false;
      shockDaysRemaining = 0;
    }
  }

  let currentMode = state.mode;
  let baselineMode = state.baselineMode;
  let crisisDayCount = state.crisisDayCount;
  let cooldownRemaining = state.cooldownRemaining;
  let baselineCooldownRemaining = state.baselineCooldownRemaining;
  let graceRemaining = state.graceRemaining;
  let crisisEventCount = state.crisisEventCount;
  let pendingIntervention = state.pendingIntervention;
  let interventionDelayRemaining = state.interventionDelayRemaining;
  const interventionMarkers = [...state.history.interventionMarkers];
  const recoveryHealthMarkers = [...state.history.recoveryHealthMarkers];

  if (pendingIntervention) {
    interventionDelayRemaining--;
    if (interventionDelayRemaining <= 0) {
      pendingIntervention = false;
      interventionDelayRemaining = 0;
      currentMode = MODES.RECOVERY;
      baselineMode = MODES.RECOVERY;
      crisisDayCount = 0;
      cooldownRemaining = cfg.cooldownDays;
      baselineCooldownRemaining = cfg.cooldownDays;
      graceRemaining = Math.floor(cfg.cooldownDays / 2);
      interventionMarkers.push(state.tick);
    }
  }

  const newSharedReality = state.sharedReality.map(r =>
    stepSharedReality(r, shockActive, shockProfile, rng)
  );

  let newAino = state.ainoDepts.map((d, i) =>
    stepAinoDept(d, cfg, shockActive, shockProfile, currentMode, newSharedReality[i], rng)
  );
  let newBaseline = state.baselineDepts.map((d, i) =>
    stepBaselineDept(d, cfg, shockActive, shockProfile, baselineMode, newSharedReality[i], rng)
  );

  if (currentMode === MODES.RECOVERY) {
    const bhSnap = computeOrgHealth(newBaseline);
    const ahSnap = computeOrgHealth(newAino);
    recoveryHealthMarkers.push({ tick: state.tick, baseHealth: bhSnap, ainoHealth: ahSnap });
    newAino = applyRecoveryToAinoDepts(newAino, rng);
    newBaseline = applyRecoveryToBaselineDepts(newBaseline, rng);
    currentMode = MODES.COOLDOWN;
    baselineMode = MODES.COOLDOWN;
  }

  let newMode, newBaselineMode;
  if (currentMode === MODES.COOLDOWN) {
    cooldownRemaining--;
    if (cooldownRemaining <= 0) {
      cooldownRemaining = 0;
      currentMode = MODES.NORMAL;
      newMode = MODES.NORMAL;
    } else {
      newMode = MODES.COOLDOWN;
    }
  } else {
    newMode = computeMode(newAino, cfg);
  }

  if (baselineMode === MODES.COOLDOWN) {
    baselineCooldownRemaining--;
    if (baselineCooldownRemaining <= 0) {
      baselineCooldownRemaining = 0;
      baselineMode = MODES.NORMAL;
      newBaselineMode = MODES.NORMAL;
    } else {
      newBaselineMode = MODES.COOLDOWN;
    }
  } else {
    newBaselineMode = MODES.NORMAL;
  }

  if (graceRemaining > 0) {
    graceRemaining--;
    if (newMode === MODES.CRISIS) newMode = MODES.TENSION;
  }

  if (newMode === MODES.CRISIS) {
    crisisDayCount++;
    if (crisisDayCount === 1) crisisEventCount++;
    if (crisisDayCount >= cfg.autoCrisisDaysForRecovery && !pendingIntervention) {
      const bhSnap = computeOrgHealth(newBaseline);
      const ahSnap = computeOrgHealth(newAino);
      recoveryHealthMarkers.push({ tick: state.tick, baseHealth: bhSnap, ainoHealth: ahSnap });
      newAino = applyRecoveryToAinoDepts(newAino, rng);
      newBaseline = applyRecoveryToBaselineDepts(newBaseline, rng);
      newMode = MODES.COOLDOWN;
      newBaselineMode = MODES.COOLDOWN;
      cooldownRemaining = cfg.cooldownDays;
      baselineCooldownRemaining = cfg.cooldownDays;
      graceRemaining = Math.floor(cfg.cooldownDays / 2);
      crisisDayCount = 0;
      interventionMarkers.push(state.tick);
    }
  } else {
    crisisDayCount = 0;
  }

  const maxReEsc = Math.max(...newAino.map(d => d.reEscalations));
  const riskDelta =
    newMode === MODES.CRISIS   ?  0.015 :
    newMode === MODES.TENSION  ?  0.005 :
    newMode === MODES.COOLDOWN ? -0.005 :
    newMode === MODES.NORMAL   ? -0.008 :
    0;
  const recoveryFiredThisTick = interventionMarkers.length > state.history.interventionMarkers.length;
  const recoveryBonus = recoveryFiredThisTick ? -state.captureRisk * 0.20 : 0;
  const newCapture = clamp(
    state.captureRisk + riskDelta + maxReEsc * 0.001 + recoveryBonus,
    0, 1
  );

  const bh = computeOrgHealth(newBaseline);
  const ah = computeOrgHealth(newAino);
  const div =
    newAino.reduce((s, d) => s + Math.abs(d.kpi - d.shadowMetric), 0) /
    newAino.length;

  const modeIntensity =
    newMode === MODES.NORMAL   ? 0.2 :
    newMode === MODES.TENSION  ? 0.6 :
    newMode === MODES.COOLDOWN ? 0.35 :
    newMode === MODES.RECOVERY ? 0.1 :
    1.0;

  return {
    ...state,
    tick: state.tick + 1,
    sharedReality: newSharedReality,
    baselineDepts: newBaseline,
    ainoDepts: newAino,
    mode: newMode,
    baselineMode: newBaselineMode,
    captureRisk: newCapture,
    shockActive,
    shockDaysRemaining,
    crisisDayCount,
    cooldownRemaining,
    baselineCooldownRemaining,
    graceRemaining,
    crisisEventCount,
    pendingIntervention,
    interventionDelayRemaining,
    rng,
    history: {
      baseHealth: [...state.history.baseHealth, bh],
      ainoHealth: [...state.history.ainoHealth, ah],
      divergence: [...state.history.divergence, div],
      mode: [...state.history.mode, modeIntensity],
      interventionMarkers,
      recoveryHealthMarkers
    }
  };
}


// ═══════════════════════════════════════════════════
// app.js
// ═══════════════════════════════════════════════════

const { useState, useEffect, useRef, useCallback } = React;

// ─── helpers ────────────────────────────────────────────────────────────────

// ─── Stability Index ─────────────────────────────────────────────────────────
// StabilityIndex = 1 – (0.4·var(modeIntensity) + 0.3·normCrises + 0.3·avgGaming)
// All components normalised to [0,1] before weighting.
// Unchanged — this is already AïnO-intrinsic (mode, divergence, crises).
function computeStabilityIndex(history, crisisCount, ticks) {
    const modes = history.mode;
    if (!modes || modes.length < 2) return null;
    const mean = modes.reduce((a, b) => a + b, 0) / modes.length;
    const variance = modes.reduce((s, v) => s + (v - mean) ** 2, 0) / modes.length;
    const normVariance = clamp(variance / 0.25, 0, 1);
    const normCrises   = clamp(crisisCount / 10, 0, 1);
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

// ─── Resilience Score (baseline-relative) ────────────────────────────────────
// Answers: "Did AïnO do BETTER than doing nothing?"
// Score = 0.5 means AïnO matched baseline. >0.5 = outperformed. <0.5 = underperformed.
//
// Components (all mapped to [0,1] centred at 0.5):
//   healthGain   = clamp(0.5 + (ainoHealth – baseHealth) * 2, 0, 1)
//                  → 0.5 when equal, 1.0 when AïnO is +0.25 ahead
//   recoverySpeed = 1 / (1 + avgCrisisDuration / ticks * 10)
//                  → pure AïnO crisis duration (no baseline equivalent)
//   captureRisk  = 1 – finalCaptureRisk
//                  → kept absolute: capture is an AïnO-specific risk
//
// ResilienceScore = 0.45·healthGain + 0.30·recoverySpeed + 0.25·(1–captureRisk)
function computeResilienceScore(history, crisisCount, finalAinoHealth, finalCaptureRisk, ticks) {
    const modes = history.mode;
    if (!modes || modes.length < 2) return null;

    const finalBaseHealth = history.baseHealth.at(-1) ?? 0.5;

    // Health gain vs baseline — centred at 0.5
    const healthGain = clamp(0.5 + (finalAinoHealth - finalBaseHealth) * 2, 0, 1);

    // Recovery speed from crisis duration
    const crisisTicks = modes.filter(m => m >= 1.0).length;
    const avgCrisisDuration = crisisCount > 0 ? crisisTicks / crisisCount : 0;
    const recoverySpeed = 1 / (1 + avgCrisisDuration / ticks * 10);

    // Capture risk penalty (AïnO-specific, absolute)
    const captureScore = 1 - finalCaptureRisk;

    const raw = 0.45 * healthGain + 0.30 * recoverySpeed + 0.25 * captureScore;
    return clamp(raw, 0, 1);
}

function resilienceLabel(rs) {
    if (rs === null) return "—";
    if (rs >= 0.65) return "Outperforms Baseline";
    if (rs >= 0.50) return "Matches Baseline";
    if (rs >= 0.35) return "Below Baseline";
    return "Significantly Worse";
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
    const healthDelta = finalAinoHealth - finalBaseHealth;

    const si = finished ? computeStabilityIndex(history, state.crisisEventCount, cfg.ticks) : null;
    const rs = finished ? computeResilienceScore(history, state.crisisEventCount, finalAinoHealth, state.captureRisk, cfg.ticks) : null;

    const siLabel = stabilityLabel(si);
    const rsLabel = resilienceLabel(rs);

    // Composite governance score — RS is now centred at 0.5 so we weight accordingly
    const govScore = (si !== null && rs !== null)
        ? clamp((si * 0.5 + rs * 0.5), 0, 1)
        : null;

    const govLabel = govScore === null ? "—"
        : govScore >= 0.65 ? "Strong Governance"
        : govScore >= 0.50 ? "Adequate Governance"
        : govScore >= 0.35 ? "Weak Governance"
        : "Governance Failure";

    const govColor = govScore === null ? "#6b7280"
        : govScore >= 0.65 ? "#4ade80"
        : govScore >= 0.50 ? "#facc15"
        : govScore >= 0.35 ? "#fb923c"
        : "#ef4444";

    const deltaColor = healthDelta > 0.02 ? "#4ade80" : healthDelta < -0.02 ? "#f87171" : "#facc15";
    const deltaSign  = healthDelta >= 0 ? "+" : "";

    return (
        <div className="bg-gray-900 rounded border border-purple-700 p-4 mb-4">
            <div className="text-sm font-bold text-purple-300 mb-1">🏛 Governance Dashboard</div>
            <div className="text-xs text-gray-500 mb-3 italic">Resilience &amp; Governance scores are <span className="text-purple-300">baseline-relative</span> — 0.50 = matched baseline, &gt;0.50 = outperformed.</div>

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
                                AïnO-intrinsic. Measures governance calm: low mode volatility, few crises, low divergence.
                            </div>
                        </div>
                        <div className="bg-gray-800 rounded p-2 border border-green-900">
                            <div className="text-green-300 font-bold mb-1">🔄 Resilience Score</div>
                            <div className="text-2xl font-bold text-green-400">{rs !== null ? rs.toFixed(3) : "—"}</div>
                            <div className="text-gray-400 mt-1">{rsLabel}</div>
                            <div className="text-xs mt-1" style={{ color: deltaColor }}>
                                Health vs baseline: {deltaSign}{(healthDelta * 100).toFixed(1)}pp
                            </div>
                            <div className="text-gray-500 mt-1 leading-tight">
                                Baseline-relative. 0.50 = matched baseline. Weights: 45% health gain, 30% recovery speed, 25% capture safety.
                            </div>
                        </div>
                        <div className="bg-gray-800 rounded p-2 border border-purple-900">
                            <div className="font-bold mb-1" style={{ color: govColor }}>⚖️ Governance Score</div>
                            <div className="text-2xl font-bold" style={{ color: govColor }}>{govScore !== null ? govScore.toFixed(3) : "—"}</div>
                            <div className="text-gray-400 mt-1">{govLabel}</div>
                            <div className="text-gray-500 mt-1 leading-tight">
                                Composite of Stability + Resilience. &gt;0.50 means AïnO added value vs no governance.
                            </div>
                        </div>
                    </div>

                    {/* Formula reference */}
                    <details className="text-xs text-gray-500">
                        <summary className="cursor-pointer hover:text-gray-300">📖 Formula reference</summary>
                        <div className="mt-2 bg-gray-800 rounded p-2 font-mono text-gray-400 leading-relaxed">
                            <div className="mb-1 text-gray-300">Stability Index (AïnO-intrinsic)</div>
                            <div>= 1 – (0.4·norm_variance(modeIntensity)</div>
                            <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ 0.3·norm(crisisCount/10)</div>
                            <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ 0.3·norm(avgDivergence/0.5))</div>
                            <div className="mt-2 mb-1 text-gray-300">Resilience Score (baseline-relative)</div>
                            <div>= 0.45·clamp(0.5 + (ainoHealth–baseHealth)·2)</div>
                            <div>&nbsp;&nbsp;+ 0.30·(1/(1 + avgCrisisDuration·10/ticks))</div>
                            <div>&nbsp;&nbsp;+ 0.25·(1 – captureRisk)</div>
                            <div className="mt-1 text-gray-500">0.50 = AïnO matched baseline exactly</div>
                            <div className="mt-2 mb-1 text-gray-300">Governance Score</div>
                            <div>= 0.5·StabilityIndex + 0.5·ResilienceScore</div>
                            <div className="mt-1 text-gray-500">Thresholds: ≥0.65 Strong · ≥0.50 Adequate · ≥0.35 Weak</div>
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
