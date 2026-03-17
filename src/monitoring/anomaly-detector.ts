/**
 * Pure math anomaly detection engine for Ada's proactive monitoring.
 * No LLM, no Supabase — takes arrays of daily metrics, returns anomaly signals.
 *
 * Key design decisions:
 * - Day-type stratified baseline (weekend vs weekday) to avoid false positives
 * - Direction-aware: only flags "bad" direction changes (CPM up = bad, CTR up = good)
 * - Minimum percent change gates to filter statistically-but-not-practically significant
 * - Spend-correlated deduplication: if spend drops, downstream volume drops are expected
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type ClientType = 'ecom' | 'lead_gen' | 'app' | 'unknown';
export type HealthStatus = 'critical' | 'alert' | 'watch' | 'healthy';

export interface DailyMetric {
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  link_clicks: number;
  content_views: number;
  add_to_carts: number;
  checkouts_initiated: number;
  purchases: number;
  purchase_value: number;
  roas: number;
  cpm: number;
  ctr: number;
  ctr_link: number;
  cpc: number;
  unique_link_clicks: number;
  results: number;
  cost_per_result: number;
  leads: number;
  complete_registrations: number;
}

export interface AnomalySignal {
  metric: string;
  severity: Severity;
  currentValue: number;
  baselineAvg: number;
  baselineStdDev: number;
  deviations: number;
  direction: 'up' | 'down';
  percentChange: number;
}

export type CompoundSignalType =
  | 'out_of_stock'
  | 'creative_fatigue'
  | 'landing_page_issue'
  | 'budget_pacing'
  | 'audience_saturation'
  | 'scaling_degradation'
  | 'checkout_friction'
  | 'lead_quality_degradation'
  | 'platform_wide';

export interface CompoundSignal {
  type: CompoundSignalType;
  severity: Severity;
  description: string;
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function getMetricValue(day: DailyMetric, metric: string): number {
  return Number((day as unknown as Record<string, unknown>)[metric]) || 0;
}

function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

/** Average ratio of numerator/denominator across days. */
function computeRate(
  days: DailyMetric[],
  numerator: string,
  denominator: string,
): number {
  let totalNum = 0;
  let totalDen = 0;
  for (const d of days) {
    totalNum += getMetricValue(d, numerator);
    totalDen += getMetricValue(d, denominator);
  }
  return totalDen > 0 ? totalNum / totalDen : 0;
}

/** Simple linear trend slope (normalized as fraction of mean). */
function computeTrend(days: DailyMetric[], metric: string): number {
  const values = days.map((d) => getMetricValue(d, metric));
  return linearTrend(values);
}

function linearTrend(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const avg = mean(values);
  if (avg === 0) return 0;

  let sumXY = 0;
  let sumX2 = 0;
  const xMean = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const xDev = i - xMean;
    sumXY += xDev * values[i]!;
    sumX2 += xDev * xDev;
  }
  const slope = sumX2 > 0 ? sumXY / sumX2 : 0;
  return slope / avg;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Client type detection
// ---------------------------------------------------------------------------

export function detectClientType(conversionGoals: unknown): ClientType {
  if (!conversionGoals || typeof conversionGoals !== 'object') return 'unknown';
  const goals = conversionGoals as Record<string, unknown>;
  const primary = goals.primary as Record<string, unknown> | undefined;
  if (!primary) return 'unknown';
  const actionType = String(primary.action_type ?? '');
  if (actionType === 'purchase' || actionType === 'omni_purchase')
    return 'ecom';
  if (actionType === 'lead') return 'lead_gen';
  if (actionType === 'app_install') return 'app';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** For each metric, the prerequisite metric and its minimum baseline average. */
const SAMPLE_MINS: Record<string, { prereq: string; min: number }> = {
  spend: { prereq: 'spend', min: 50 },
  impressions: { prereq: 'spend', min: 50 },
  cpm: { prereq: 'spend', min: 50 },
  cpc: { prereq: 'spend', min: 50 },
  frequency: { prereq: 'spend', min: 50 },
  reach: { prereq: 'spend', min: 50 },
  ctr: { prereq: 'clicks', min: 100 },
  roas: { prereq: 'purchases', min: 10 },
  purchases: { prereq: 'purchases', min: 10 },
  purchase_value: { prereq: 'purchases', min: 10 },
  add_to_carts: { prereq: 'add_to_carts', min: 50 },
  checkouts_initiated: { prereq: 'checkouts_initiated', min: 50 },
  content_views: { prereq: 'content_views', min: 50 },
  cost_per_result: { prereq: 'results', min: 10 },
  leads: { prereq: 'leads', min: 10 },
  complete_registrations: { prereq: 'complete_registrations', min: 10 },
  results: { prereq: 'results', min: 10 },
};

const METRICS_BY_TYPE: Record<ClientType, string[]> = {
  ecom: [
    'spend', 'cpm', 'ctr', 'cpc', 'frequency', 'roas',
    'purchases', 'purchase_value', 'add_to_carts',
    'checkouts_initiated', 'content_views',
  ],
  lead_gen: [
    'spend', 'cpm', 'ctr', 'cpc', 'frequency',
    'cost_per_result', 'leads', 'complete_registrations', 'results',
  ],
  app: [
    'spend', 'cpm', 'ctr', 'cpc', 'frequency',
    'cost_per_result', 'results',
  ],
  unknown: ['spend', 'cpm', 'ctr', 'cpc', 'frequency'],
};

/**
 * Which direction is "bad" (actionable) for each metric.
 * 'up' = increase is bad, 'down' = decrease is bad, 'both' = either direction.
 * Metrics not listed default to 'both'.
 */
const BAD_DIRECTION: Record<string, 'up' | 'down' | 'both'> = {
  // Cost metrics: increase = bad
  cpm: 'up',
  cpc: 'up',
  cost_per_result: 'up',
  frequency: 'up',
  // Efficiency metrics: decrease = bad
  ctr: 'down',
  roas: 'down',
  // Volume metrics: decrease = bad (usually means delivery issue)
  purchases: 'down',
  purchase_value: 'down',
  leads: 'down',
  complete_registrations: 'down',
  results: 'down',
  add_to_carts: 'down',
  checkouts_initiated: 'down',
  content_views: 'down',
  // Spend: both directions matter (underspend or overspend)
  spend: 'both',
};

/** Minimum absolute percent change required for each severity level. */
const MIN_PCT_CHANGE: Record<Severity, number> = {
  P0: 35,
  P1: 20,
  P2: 15,
  P3: 10,
};

/**
 * Volume metrics that scale proportionally with spend.
 * Used for deduplication: if spend drops 30%, these dropping ~30% is expected.
 */
const SPEND_CORRELATED = new Set([
  'impressions', 'reach', 'clicks', 'link_clicks', 'unique_link_clicks',
  'purchases', 'purchase_value', 'leads', 'complete_registrations', 'results',
  'add_to_carts', 'checkouts_initiated', 'content_views',
]);

// ---------------------------------------------------------------------------
// Core: detectAnomalies
// ---------------------------------------------------------------------------

export function detectAnomalies(
  dailyMetrics: DailyMetric[],
  conversionGoals: unknown,
  _targets?: Record<string, unknown>,
): AnomalySignal[] {
  if (dailyMetrics.length < 8) return [];

  const clientType = detectClientType(conversionGoals);
  const metricsToCheck = METRICS_BY_TYPE[clientType];

  // Sort ascending by date
  const sorted = [...dailyMetrics].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const today = sorted[sorted.length - 1]!;
  const allPrior = sorted.slice(0, -1);

  // Day-type stratified baseline: compare weekends to weekends, weekdays to weekdays
  const todayIsWeekend = isWeekend(today.date);
  const sameTypeDays = allPrior.filter(
    (d) => isWeekend(d.date) === todayIsWeekend,
  );
  // Use same-type if we have ≥3 data points, otherwise fall back to full prior
  const baseline = sameTypeDays.length >= 3 ? sameTypeDays : allPrior;
  // When using mixed baseline on a weekend day, require higher sigma
  const sigmaBuffer =
    todayIsWeekend && sameTypeDays.length < 3 ? 1.0 : 0;

  const anomalies: AnomalySignal[] = [];

  for (const metric of metricsToCheck) {
    const baselineValues = baseline.map((d) => getMetricValue(d, metric));
    const todayValue = getMetricValue(today, metric);

    // Check sample minimum
    const minConfig = SAMPLE_MINS[metric];
    if (minConfig) {
      const prereqValues = baseline.map((d) =>
        getMetricValue(d, minConfig.prereq),
      );
      if (mean(prereqValues) < minConfig.min) continue;
    }

    const baselineAvg = mean(baselineValues);
    const baselineStd = stdDev(baselineValues, baselineAvg);

    if (baselineStd === 0 && baselineAvg === todayValue) continue;

    const effectiveStd =
      baselineStd === 0 ? Math.abs(baselineAvg) * 0.15 || 1 : baselineStd;
    const deviations = Math.abs(todayValue - baselineAvg) / effectiveStd;

    // Apply sigma buffer for weekend/mixed-baseline adjustment
    const adjustedDeviation = deviations - sigmaBuffer;
    if (adjustedDeviation < 1.5) continue;

    const direction: 'up' | 'down' =
      todayValue > baselineAvg ? 'up' : 'down';
    const percentChange =
      baselineAvg !== 0
        ? ((todayValue - baselineAvg) / baselineAvg) * 100
        : todayValue > 0
          ? 100
          : 0;

    const absPctChange = Math.abs(percentChange);

    // Direction filter: skip "good" direction changes
    const badDir = BAD_DIRECTION[metric] ?? 'both';
    if (badDir !== 'both' && badDir !== direction) continue;

    // Determine severity from sigma
    let severity: Severity;
    if (adjustedDeviation >= 3) severity = 'P0';
    else if (adjustedDeviation >= 2) severity = 'P1';
    else severity = 'P2';

    // Enforce minimum percent change for each severity level
    while (severity !== 'P2' && absPctChange < MIN_PCT_CHANGE[severity]) {
      severity = severity === 'P0' ? 'P1' : 'P2';
    }
    if (absPctChange < MIN_PCT_CHANGE.P2) continue;

    // Special case: 0 conversions with >$100 spend = always P0
    if (
      ['purchases', 'results', 'leads'].includes(metric) &&
      todayValue === 0 &&
      today.spend > 100
    ) {
      severity = 'P0';
    }

    anomalies.push({
      metric,
      severity,
      currentValue: todayValue,
      baselineAvg: Math.round(baselineAvg * 100) / 100,
      baselineStdDev: Math.round(baselineStd * 100) / 100,
      deviations: Math.round(deviations * 10) / 10,
      direction,
      percentChange: Math.round(percentChange),
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Spend-correlated deduplication
// ---------------------------------------------------------------------------

/**
 * Two-pass deduplication:
 * 1. Remove volume metrics that changed proportionally to spend (correlated noise)
 * 2. Cap remaining volume anomalies to top 2 (avoid funnel flooding)
 */
export function deduplicateAnomalies(anomalies: AnomalySignal[]): AnomalySignal[] {
  // Pass 1: Remove spend-correlated volume metrics
  const spendAnomaly = anomalies.find((a) => a.metric === 'spend');
  let filtered = anomalies;

  if (spendAnomaly) {
    const spendPctChange = spendAnomaly.percentChange;
    filtered = anomalies.filter((a) => {
      if (a.metric === 'spend') return true;
      if (!SPEND_CORRELATED.has(a.metric)) return true;
      if (a.direction !== spendAnomaly.direction) return true;

      // Keep if disproportionately worse than spend change
      const excessChange =
        Math.abs(a.percentChange) - Math.abs(spendPctChange);
      return excessChange > 20;
    });
  }

  // Pass 2: Among remaining volume metrics, keep at most 2 (most severe / biggest change)
  const EFFICIENCY = new Set([
    'cpm', 'cpc', 'ctr', 'roas', 'cost_per_result', 'frequency', 'spend',
  ]);
  const efficiencyAnomalies = filtered.filter((a) => EFFICIENCY.has(a.metric));
  const volumeAnomalies = filtered
    .filter((a) => !EFFICIENCY.has(a.metric))
    .sort((a, b) => {
      const sevDiff = severityRank(a.severity) - severityRank(b.severity);
      if (sevDiff !== 0) return sevDiff;
      return Math.abs(b.percentChange) - Math.abs(a.percentChange);
    });

  return [...efficiencyAnomalies, ...volumeAnomalies.slice(0, 2)];
}

function severityRank(s: Severity): number {
  switch (s) {
    case 'P0': return 0;
    case 'P1': return 1;
    case 'P2': return 2;
    case 'P3': return 3;
  }
}

// ---------------------------------------------------------------------------
// Core: detectCompoundSignals
// ---------------------------------------------------------------------------

export function detectCompoundSignals(
  anomalies: AnomalySignal[],
  dailyMetrics: DailyMetric[],
  conversionGoals: unknown,
  targets?: Record<string, unknown>,
): CompoundSignal[] {
  const clientType = detectClientType(conversionGoals);
  const compounds: CompoundSignal[] = [];

  const sorted = [...dailyMetrics].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (sorted.length < 2) return [];

  const today = sorted[sorted.length - 1]!;
  const baseline = sorted.slice(
    Math.max(0, sorted.length - 8),
    sorted.length - 1,
  );

  const anomalyMap = new Map(anomalies.map((a) => [a.metric, a]));
  const hasAnomaly = (metric: string, direction?: 'up' | 'down') => {
    const a = anomalyMap.get(metric);
    if (!a) return false;
    if (direction && a.direction !== direction) return false;
    return true;
  };

  // 1. Out of Stock (E-COM): ATC rate drops >40% while traffic stable
  if (clientType === 'ecom' && baseline.length >= 3) {
    const baselineAtcRate = computeRate(
      baseline,
      'add_to_carts',
      'content_views',
    );
    const todayAtcRate =
      today.content_views > 0 ? today.add_to_carts / today.content_views : 0;
    if (
      baselineAtcRate > 0 &&
      todayAtcRate / baselineAtcRate < 0.6 &&
      !hasAnomaly('ctr', 'down') &&
      !hasAnomaly('spend', 'down')
    ) {
      compounds.push({
        type: 'out_of_stock',
        severity: 'P0',
        description:
          'ATC rate dropped >40% while traffic stable — possible out of stock',
        evidence: [
          `ATC rate: ${pct(todayAtcRate)} (was ${pct(baselineAtcRate)})`,
          `Traffic stable: ${today.impressions.toLocaleString()} impressions`,
        ],
      });
    }
  }

  // 2. Creative Fatigue: frequency >3.0 + CTR declining + CPM stable
  if (
    today.frequency > 3.0 &&
    hasAnomaly('ctr', 'down') &&
    !hasAnomaly('cpm', 'up')
  ) {
    const ctrAnomaly = anomalyMap.get('ctr')!;
    compounds.push({
      type: 'creative_fatigue',
      severity: 'P1',
      description: `Frequency ${today.frequency.toFixed(1)} with declining CTR — creative fatigue`,
      evidence: [
        `Frequency: ${today.frequency.toFixed(1)}`,
        `CTR: ${ctrAnomaly.percentChange}% change`,
      ],
    });
  }

  // 3. Landing Page Issue (E-COM): CTR stable but PDP view rate drops >30%
  if (clientType === 'ecom' && baseline.length >= 3) {
    const baselinePdpRate = computeRate(
      baseline,
      'content_views',
      'link_clicks',
    );
    const todayPdpRate =
      today.link_clicks > 0 ? today.content_views / today.link_clicks : 0;
    if (
      baselinePdpRate > 0 &&
      todayPdpRate / baselinePdpRate < 0.7 &&
      !hasAnomaly('ctr', 'down') &&
      !hasAnomaly('spend', 'down')
    ) {
      compounds.push({
        type: 'landing_page_issue',
        severity: 'P1',
        description:
          'PDP view rate dropped >30% while CTR stable — landing page issue',
        evidence: [
          `PDP view rate: ${pct(todayPdpRate)} (was ${pct(baselinePdpRate)})`,
          'CTR stable',
        ],
      });
    }
  }

  // 4. Budget Pacing (requires client targets)
  const dailyBudget = Number(
    (targets as Record<string, unknown> | undefined)?.daily_budget,
  );
  if (dailyBudget > 0 && today.spend > 0) {
    const pacingRatio = today.spend / dailyBudget;
    if (pacingRatio > 1.5) {
      compounds.push({
        type: 'budget_pacing',
        severity: 'P0',
        description: `Overspend: ${Math.round(pacingRatio * 100)}% of daily target`,
        evidence: [
          `Spend: $${today.spend.toFixed(2)} (target: $${dailyBudget})`,
        ],
      });
    } else if (pacingRatio > 1.3) {
      compounds.push({
        type: 'budget_pacing',
        severity: 'P1',
        description: `Overspend: ${Math.round(pacingRatio * 100)}% of daily target`,
        evidence: [
          `Spend: $${today.spend.toFixed(2)} (target: $${dailyBudget})`,
        ],
      });
    } else if (pacingRatio < 0.5) {
      // Only flag severe underspend — mild underspend on weekends is normal
      compounds.push({
        type: 'budget_pacing',
        severity: 'P1',
        description: `Underspend: ${Math.round(pacingRatio * 100)}% of daily target`,
        evidence: [
          `Spend: $${today.spend.toFixed(2)} (target: $${dailyBudget})`,
        ],
      });
    }
  }

  // 5. Audience Saturation: frequency rising + CPA rising + reach declining (7+ day trend)
  if (sorted.length >= 7) {
    const last7 = sorted.slice(-7);
    const freqTrend = computeTrend(last7, 'frequency');
    const reachTrend = computeTrend(last7, 'reach');

    let cpaTrend = 0;
    if (clientType === 'ecom') {
      const cpas = last7.map((d) =>
        d.purchases > 0 ? d.spend / d.purchases : 0,
      );
      cpaTrend = linearTrend(cpas);
    } else {
      cpaTrend = computeTrend(last7, 'cost_per_result');
    }

    // Require meaningful trends (>3%/day), not noise
    if (freqTrend > 0.03 && cpaTrend > 0.03 && reachTrend < -0.03) {
      compounds.push({
        type: 'audience_saturation',
        severity: 'P1',
        description:
          'Frequency rising + CPA rising + reach declining — audience saturation',
        evidence: [
          `Frequency trend: +${(freqTrend * 100).toFixed(1)}%/day`,
          `CPA trend: +${(cpaTrend * 100).toFixed(1)}%/day`,
          `Reach trend: ${(reachTrend * 100).toFixed(1)}%/day`,
        ],
      });
    }
  }

  // 6. Scaling Degradation: budget +30% in 3 days + CPA +20% + freq rising
  if (sorted.length >= 4) {
    const last4 = sorted.slice(-4);
    const first = last4[0]!;
    const last = last4[3]!;
    const spendFirst = first.spend || 1;
    const spendChange = (last.spend - spendFirst) / spendFirst;

    let cpaChange = 0;
    if (clientType === 'ecom') {
      const cpaFirst =
        first.purchases > 0 ? first.spend / first.purchases : 0;
      const cpaLast = last.purchases > 0 ? last.spend / last.purchases : 0;
      cpaChange = cpaFirst > 0 ? (cpaLast - cpaFirst) / cpaFirst : 0;
    } else {
      const crFirst = first.cost_per_result || 1;
      cpaChange = (last.cost_per_result - crFirst) / crFirst;
    }
    const freqFirst = first.frequency || 1;
    const freqChange = (last.frequency - freqFirst) / freqFirst;

    if (spendChange > 0.3 && cpaChange > 0.2 && freqChange > 0) {
      compounds.push({
        type: 'scaling_degradation',
        severity: 'P1',
        description: `Budget +${Math.round(spendChange * 100)}% in 3 days with CPA +${Math.round(cpaChange * 100)}% — scaling degradation`,
        evidence: [
          `Spend: $${first.spend.toFixed(0)} -> $${last.spend.toFixed(0)} (+${Math.round(spendChange * 100)}%)`,
          `CPA: +${Math.round(cpaChange * 100)}%`,
          `Frequency: +${Math.round(freqChange * 100)}%`,
        ],
      });
    }
  }

  // 7. Checkout Friction (E-COM): ATC stable but checkout rate drops >30%
  if (clientType === 'ecom' && baseline.length >= 3) {
    const baselineCheckoutRate = computeRate(
      baseline,
      'checkouts_initiated',
      'add_to_carts',
    );
    const todayCheckoutRate =
      today.add_to_carts > 0
        ? today.checkouts_initiated / today.add_to_carts
        : 0;
    if (
      baselineCheckoutRate > 0 &&
      todayCheckoutRate / baselineCheckoutRate < 0.7 &&
      !hasAnomaly('add_to_carts', 'down')
    ) {
      compounds.push({
        type: 'checkout_friction',
        severity: 'P1',
        description:
          'Checkout rate dropped >30% while ATCs stable — checkout friction',
        evidence: [
          `Checkout rate: ${pct(todayCheckoutRate)} (was ${pct(baselineCheckoutRate)})`,
          `ATCs stable: ${today.add_to_carts}`,
        ],
      });
    }
  }

  // 8. Lead Quality Degradation (LEAD_GEN): CPL stable but registrations drop
  if (clientType === 'lead_gen' && baseline.length >= 3) {
    const baselineRegRate = computeRate(
      baseline,
      'complete_registrations',
      'leads',
    );
    const todayRegRate =
      today.leads > 0 ? today.complete_registrations / today.leads : 0;
    if (
      baselineRegRate > 0 &&
      todayRegRate / baselineRegRate < 0.7 &&
      !hasAnomaly('cost_per_result', 'up')
    ) {
      compounds.push({
        type: 'lead_quality_degradation',
        severity: 'P1',
        description:
          'Registration rate dropped while CPL stable — lead quality degradation',
        evidence: [
          `Registration rate: ${pct(todayRegRate)} (was ${pct(baselineRegRate)})`,
          `CPL stable: $${today.cost_per_result.toFixed(2)}`,
        ],
      });
    }
  }

  return compounds;
}

// ---------------------------------------------------------------------------
// Core: detectPlatformIssues
// ---------------------------------------------------------------------------

export function detectPlatformIssues(
  allClientAnomalies: Map<string, AnomalySignal[]>,
): CompoundSignal | null {
  // Skip platform-wide detection on weekends — spend/volume naturally varies
  const today = new Date();
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return null;

  // If 3+ clients show the same metric anomaly in the same direction
  // Only count P0/P1 anomalies, exclude spend (too correlated with budgets)
  const metricCounts = new Map<
    string,
    { clients: string[]; direction: 'up' | 'down' }
  >();

  for (const [clientCode, anomalies] of allClientAnomalies) {
    for (const anomaly of anomalies) {
      if (anomaly.severity !== 'P0' && anomaly.severity !== 'P1') continue;
      if (anomaly.metric === 'spend') continue;
      const key = `${anomaly.metric}:${anomaly.direction}`;
      const entry = metricCounts.get(key);
      if (entry) {
        if (!entry.clients.includes(clientCode)) {
          entry.clients.push(clientCode);
        }
      } else {
        metricCounts.set(key, {
          clients: [clientCode],
          direction: anomaly.direction,
        });
      }
    }
  }

  // Need 3+ clients on the same metric+direction, and it must be >40% of clients
  const totalClients = allClientAnomalies.size;
  for (const [key, { clients, direction }] of metricCounts) {
    if (clients.length >= 3 && clients.length >= totalClients * 0.4) {
      const metric = key.split(':')[0];
      return {
        type: 'platform_wide',
        severity: 'P2',
        description: `Platform-wide issue: ${metric} ${direction} across ${clients.length} clients`,
        evidence: [`Affected: ${clients.join(', ')}`],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core: deriveHealth
// ---------------------------------------------------------------------------

export function deriveHealth(
  anomalies: AnomalySignal[],
  compounds: CompoundSignal[],
): HealthStatus {
  const allSeverities = [
    ...anomalies.map((a) => a.severity),
    ...compounds.map((c) => c.severity),
  ];

  if (allSeverities.includes('P0')) return 'critical';
  if (allSeverities.includes('P1')) return 'alert';
  if (allSeverities.includes('P2')) return 'watch';
  return 'healthy';
}
