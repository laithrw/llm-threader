import { BayesianOptimizer } from "bayesian-optimizer";
import { UsageHistoryManager } from "./UsageHistoryManager.js";

class PIDController {
  constructor({
    kp = 0.5,
    ki = 0.05,
    kd = 0.1,
    setpoint = 90,
    outputMin = 1,
    outputMax = 12,
  } = {}) {
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.setpoint = setpoint;
    this.outputMin = outputMin;
    this.outputMax = outputMax;
    this.integral = 0;
    this.lastError = 0;
    this.lastTime = null;
  }

  update(measured, now = Date.now()) {
    const error = this.setpoint - measured;
    const dt = this.lastTime ? (now - this.lastTime) / 1000 : 1;
    this.integral += error * dt;
    const derivative = dt > 0 ? (error - this.lastError) / dt : 0;
    const output =
      this.kp * error + this.ki * this.integral + this.kd * derivative;
    this.lastError = error;
    this.lastTime = now;
    return Math.max(
      this.outputMin,
      Math.min(this.outputMax, Math.round(output))
    );
  }
}

export class ScalingDecisionEngine {
  constructor(options = {}) {
    this.minDataWindow = options.minDataWindow || 30000;
    this.stabilityWindow = options.stabilityWindow || 60000;

    this.emergencyAbsoluteLimits = {
      cpuTemp: options.emergencyAbsoluteLimits?.cpuTemp || 95,
      cpuUsage: options.emergencyAbsoluteLimits?.cpuUsage || 98,
      memoryUsage: options.emergencyAbsoluteLimits?.memoryUsage || 95,
      gpuTemp: options.emergencyAbsoluteLimits?.gpuTemp || 95,
      gpuUsage: options.emergencyAbsoluteLimits?.gpuUsage || 98,
    };

    this.highThresholds = {
      cpuUsage: options.highThresholds?.cpuUsage || 85,
      cpuTemp: options.highThresholds?.cpuTemp || 85,
      memoryUsage: options.highThresholds?.memoryUsage || 85,
      gpuTemp: options.highThresholds?.gpuTemp || 85,
      gpuUsage: options.highThresholds?.gpuUsage || 85,
    };

    this.performanceHistory = [];
    this.maxPerformanceHistory = 200;

    this.threadScalingHistory = [];
    this.maxScalingHistory = 100;

    this.lastRecommendedThreads = 1;
    this.lastScalingDecision = Date.now();
    this.pendingScaleUpValidation = null;

    this.demandHistory = [];
    this.maxDemandHistory = 50;

    this.operationIntensityProfiles = {};

    this.useOptimalMaxThreads =
      options.maxThreads === undefined || options.maxThreads === null;
    this.configuredMaxThreads =
      Number.isFinite(options.maxThreads) && options.maxThreads > 0
        ? options.maxThreads
        : null;
    // When using optimal max threads, there's no hard limit - we search until performance degrades
    const defaultMaxThreads = this.useOptimalMaxThreads
      ? null
      : this.configuredMaxThreads || 12;
    this.defaultMaxThreads = defaultMaxThreads;
    this.maxThreads = this.configuredMaxThreads ?? Infinity;
    this.optimalMaxThreads = null;
    this.performanceByThreadCount = {}; // { threadCount: { throughput: [], latency: [], cumulativeTime: [], samples: [] } }
    this.dynamicExplorationCeiling = this.computeExplorationCeiling();
    this.currentOptimalEfficiency = null;

    this.pid = new PIDController({
      kp: options.kp || 0.5,
      ki: options.ki || 0.05,
      kd: options.kd || 0.1,
      setpoint: options.setpoint || 90,
      outputMin: 1,
      outputMax: this.dynamicExplorationCeiling,
    });

    this.lastTemp = null;
    this.tempDeltas = [];
    this.tempWindow = 10;

    this.bayes = new BayesianOptimizer({
      exploration: 0.02,
      numCandidates: 20,
    });
    this.bayesSearchSpace = {
      threads: {
        min: 1,
        max: this.dynamicExplorationCeiling,
      },
    };

    this.minCooldown = Math.min(10000, 2 * this.estimateThermalTimeConstant());
    this.scaleCooldownMs = options.scaleCooldownMs || this.minCooldown || 10000;
    this.lastScalingDecision = Date.now() - this.scaleCooldownMs;
    this.lastScalingDecision = Date.now() - this.scaleCooldownMs;
    this.consecutiveEmergencies = 0;
    this.lastStableTime = Date.now();

    this.defaultMaxThreads = defaultMaxThreads;

    // Each scaling engine instance maintains its own usage history manager
    this.usageHistoryManager = new UsageHistoryManager({
      maxHistoryAgeMinutes: options.maxHistoryAgeMinutes || 5,
      maxDataPoints: options.maxDataPoints || 300,
    });
  }

  recordPerformanceData(
    metrics,
    currentThreads,
    queuePressure = 0,
    activeThreads = 0,
    operationMix = {},
    operationMixContext = null,
    throughput = null,
    avgLatency = null,
    backlogSize = null
  ) {
    const latest = metrics[metrics.length - 1] || {};

    const cpuUsage =
      latest.avgCpuUsage ?? latest.cpuLoad ?? latest.cpu_usage ?? null;
    const cpuTemp =
      latest.avgCpuTemp ?? latest.avgTemp ?? latest.cpu_temp ?? null;
    const memoryUsage =
      latest.avgMemoryUsage ?? latest.memoryUsage ?? latest.mem_usage ?? null;
    const gpuTemp = latest.avgGpuTemp ?? latest.gpuTemp ?? null;
    const gpuUsage = latest.avgGpuUsage ?? latest.gpuUsage ?? null;

    const performancePoint = {
      timestamp: Date.now(),
      cpuUsage,
      cpuTemp,
      memoryUsage,
      gpuTemp,
      gpuUsage,
      concurrentThreads: currentThreads,
      activeThreads: activeThreads,
      queuePressure,
      operationMix: { ...operationMix },
      operationIntensity: operationMixContext?.currentIntensity || 0,
      totalOperations: operationMixContext?.totalOperations || 0,
      stable: true,
      utilization: activeThreads / Math.max(currentThreads, 1),
      throughput,
      avgLatency,
      backlog: backlogSize,
    };

    this.performanceHistory.push(performancePoint);
    if (this.performanceHistory.length > this.maxPerformanceHistory) {
      this.performanceHistory.shift();
    }

    if (
      this.useOptimalMaxThreads &&
      throughput !== null &&
      avgLatency !== null
    ) {
      this.trackPerformanceByThreadCount(
        currentThreads,
        throughput,
        avgLatency,
        backlogSize ?? queuePressure + activeThreads
      );
    }

    this.usageHistoryManager.addUsageData({
      cpuUsage,
      cpuTemp,
      memoryUsage,
      gpuTemp,
      gpuUsage,
      concurrentThreads: currentThreads,
      activeThreads: activeThreads,
      queuePressure,
      operationMix: { ...operationMix },
      operationIntensity: operationMixContext?.currentIntensity || 0,
    });

    const demandPoint = {
      timestamp: Date.now(),
      queuePressure,
      activeThreads,
      maxThreads: currentThreads,
      utilization: performancePoint.utilization,
      hasUnmetDemand:
        (queuePressure > 0 && activeThreads >= currentThreads) ||
        (backlogSize ?? queuePressure + activeThreads) >= currentThreads,
      operationIntensity: operationMixContext?.currentIntensity || 0,
      backlog: backlogSize,
    };

    this.demandHistory.push(demandPoint);
    if (this.demandHistory.length > this.maxDemandHistory) {
      this.demandHistory.shift();
    }
  }

  trackPerformanceByThreadCount(
    threadCount,
    throughput,
    avgLatency,
    backlogSize = null
  ) {
    if (!this.performanceByThreadCount[threadCount]) {
      this.performanceByThreadCount[threadCount] = {
        throughput: [],
        latency: [],
        cumulativeTime: [],
        backlog: [],
        samples: [],
        lastUpdate: Date.now(),
      };
    }

    const perf = this.performanceByThreadCount[threadCount];
    const normalizedLatency =
      avgLatency !== null && avgLatency !== undefined
        ? Math.max(avgLatency, 0)
        : 0;
    const latencySeconds = Math.max(normalizedLatency || 1, 1) / 1000;
    const measuredThroughput =
      throughput !== null && throughput !== undefined
        ? Math.max(throughput, 0)
        : null;
    const fallbackThroughput =
      latencySeconds > 0 ? threadCount / latencySeconds : threadCount;
    const effectiveThroughput =
      measuredThroughput && measuredThroughput > 0
        ? measuredThroughput
        : fallbackThroughput;
    const backlog =
      backlogSize !== null && backlogSize !== undefined
        ? Math.max(backlogSize, 1)
        : Math.max(threadCount, 1);
    const cumulativeTime = this.calculateCumulativeTimeEstimate({
      backlog,
      throughput: effectiveThroughput,
      latencySeconds,
      threadCount,
    });

    perf.throughput.push(effectiveThroughput);
    perf.latency.push(normalizedLatency);
    perf.cumulativeTime.push(cumulativeTime);
    perf.backlog.push(backlog);
    perf.samples.push({
      throughput: effectiveThroughput,
      latency: normalizedLatency,
      cumulativeTime,
      backlog,
      timestamp: Date.now(),
    });
    perf.lastUpdate = Date.now();

    if (perf.throughput.length > 20) {
      perf.throughput.shift();
      perf.latency.shift();
      perf.cumulativeTime.shift();
      perf.backlog.shift();
      perf.samples.shift();
    }

    this.updateOptimalMaxThreads();
    this.refreshExplorationCeiling();
  }

  updateOptimalMaxThreads() {
    const threadCounts = Object.keys(this.performanceByThreadCount)
      .map(Number)
      .sort((a, b) => a - b);

    if (threadCounts.length === 0) {
      return;
    }

    let bestThreadCount = this.optimalMaxThreads ?? threadCounts[0];
    let bestEfficiency = -Infinity;
    const efficiencyByThread = new Map();
    const sampleRequirement = Math.max(
      5,
      Math.ceil(this.performanceHistory.length * 0.05) || 5
    );

    for (const threadCount of threadCounts) {
      const perf = this.performanceByThreadCount[threadCount];
      if (
        !perf ||
        perf.throughput.length < sampleRequirement ||
        perf.cumulativeTime.length < sampleRequirement
      )
        continue;

      const avgThroughput =
        perf.throughput.reduce((a, b) => a + b, 0) / perf.throughput.length;
      const avgLatency =
        perf.latency.reduce((a, b) => a + b, 0) / perf.latency.length;
      const avgCumulativeTime =
        perf.cumulativeTime.reduce((a, b) => a + b, 0) /
        perf.cumulativeTime.length;

      const prevStats = this.selectPreviousThreadStats(
        threadCounts,
        threadCount
      );
      const efficiency = this.calculateEfficiencyScore({
        threadCount,
        avgThroughput,
        avgLatency,
        avgCumulativeTime,
        prevAvgThroughput: prevStats?.avgThroughput ?? null,
        prevAvgLatency: prevStats?.avgLatency ?? null,
        prevAvgCumulativeTime: prevStats?.avgCumulativeTime ?? null,
      });
      efficiencyByThread.set(threadCount, efficiency);

      if (efficiency > bestEfficiency) {
        bestEfficiency = efficiency;
        bestThreadCount = threadCount;
      }
    }

    if (bestEfficiency === -Infinity) {
      return;
    }

    const prevOptimal = this.optimalMaxThreads;
    const prevEfficiency =
      (prevOptimal !== null && efficiencyByThread.has(prevOptimal)) ||
      this.currentOptimalEfficiency !== null
        ? efficiencyByThread.get(prevOptimal) ?? this.currentOptimalEfficiency
        : null;
    const improvementMargin = this.calculateEfficiencyImprovementMargin(
      prevEfficiency,
      bestEfficiency
    );

    if (
      prevOptimal !== null &&
      bestThreadCount !== prevOptimal &&
      prevEfficiency !== null &&
      bestEfficiency < prevEfficiency + improvementMargin
    ) {
      return;
    }

    if (bestThreadCount !== this.optimalMaxThreads) {
      this.optimalMaxThreads = bestThreadCount;
      if (prevOptimal !== null) {
        console.log(
          `[Scaling Engine] Optimal max threads updated: ${prevOptimal} -> ${bestThreadCount} (efficiency: ${bestEfficiency.toFixed(
            2
          )})`
        );
      }
      this.refreshExplorationCeiling();
    }
    this.currentOptimalEfficiency = bestEfficiency;
  }

  calculateEfficiencyScore({
    threadCount,
    avgThroughput,
    avgLatency,
    avgCumulativeTime,
    prevAvgThroughput,
    prevAvgLatency,
    prevAvgCumulativeTime,
  }) {
    if (!isFinite(avgCumulativeTime) || avgCumulativeTime <= 0) {
      return -Infinity;
    }

    const latencySeconds = Math.max(avgLatency || 0, 1) / 1000;
    let efficiency =
      -avgCumulativeTime +
      Math.log(avgThroughput + 1) -
      Math.log(latencySeconds + 1) * 0.1;

    efficiency -= Math.log(threadCount + 1) * 0.02;

    if (
      prevAvgCumulativeTime !== null &&
      prevAvgCumulativeTime > 0 &&
      avgCumulativeTime > prevAvgCumulativeTime * 1.03
    ) {
      efficiency -= (avgCumulativeTime - prevAvgCumulativeTime) * 5;
    }

    if (
      prevAvgThroughput !== null &&
      prevAvgThroughput > 0 &&
      avgThroughput < prevAvgThroughput * 0.97
    ) {
      efficiency -= (prevAvgThroughput - avgThroughput) * 10;
    }

    if (
      prevAvgLatency !== null &&
      avgLatency > 0 &&
      avgLatency > prevAvgLatency * 1.05
    ) {
      efficiency -= ((avgLatency - prevAvgLatency) / 1000) * 5;
    }

    return efficiency;
  }

  calculateEfficiencyImprovementMargin(prevEfficiency, nextEfficiency) {
    if (!Number.isFinite(prevEfficiency)) {
      return 0;
    }
    const scale =
      Math.max(Math.abs(prevEfficiency), Math.abs(nextEfficiency) || 0, 1) *
      0.02;
    return Math.max(5, scale);
  }

  selectPreviousThreadStats(sortedThreadCounts, currentThreadCount) {
    const currentIndex = sortedThreadCounts.indexOf(currentThreadCount);
    if (currentIndex <= 0) {
      return null;
    }

    for (let i = currentIndex - 1; i >= 0; i--) {
      const candidateCount = sortedThreadCounts[i];
      const perf = this.performanceByThreadCount[candidateCount];
      if (!perf) {
        continue;
      }
      if (perf.throughput.length < 5 || perf.cumulativeTime.length < 5) {
        continue;
      }

      const avgThroughput =
        perf.throughput.reduce((a, b) => a + b, 0) / perf.throughput.length;
      const avgLatency =
        perf.latency.reduce((a, b) => a + b, 0) / perf.latency.length;
      const avgCumulativeTime =
        perf.cumulativeTime.reduce((a, b) => a + b, 0) /
        perf.cumulativeTime.length;

      return { avgThroughput, avgLatency, avgCumulativeTime };
    }

    return null;
  }

  calculateCumulativeTimeEstimate({
    backlog,
    throughput,
    latencySeconds,
    threadCount,
  }) {
    const safeThroughput = Math.max(throughput || 0, 1e-6);
    const effectiveBacklog = Math.max(backlog || threadCount || 1, 1);
    return effectiveBacklog / safeThroughput;
  }

  computeExplorationCeiling() {
    if (!this.useOptimalMaxThreads) {
      return this.configuredMaxThreads || 12;
    }

    const historyMax =
      this.performanceHistory.length > 0
        ? Math.max(
            ...this.performanceHistory.map(
              (point) => point.concurrentThreads || 1
            )
          )
        : Math.max(this.lastRecommendedThreads, 1);

    const demandPush =
      this.demandHistory.length > 0
        ? Math.max(
            ...this.demandHistory.map((point) =>
              Math.max(
                (point.queuePressure || 0) + (point.activeThreads || 0),
                0
              )
            )
          )
        : 0;

    const base = Math.max(historyMax, this.lastRecommendedThreads, 1);
    const optimalBias =
      this.optimalMaxThreads !== null
        ? Math.max(this.optimalMaxThreads + 4, base)
        : base;

    const ceiling = Math.max(base * 2, optimalBias, demandPush + base + 1);
    return Math.max(4, Math.ceil(ceiling));
  }

  refreshExplorationCeiling() {
    const ceiling = this.computeExplorationCeiling();
    if (ceiling !== this.dynamicExplorationCeiling) {
      this.dynamicExplorationCeiling = ceiling;
      this.pid.outputMax = ceiling;
      this.bayesSearchSpace.threads.max = ceiling;
    }
    return this.dynamicExplorationCeiling;
  }

  getThreadPerformanceStats(threadCount) {
    const perf = this.performanceByThreadCount[threadCount];
    if (!perf) {
      return null;
    }

    const avgThroughput = this.calculateAverage(perf.throughput);
    const avgLatency = this.calculateAverage(perf.latency);
    const avgCumulativeTime = this.calculateAverage(perf.cumulativeTime);
    const variance = this.computeCoefficientOfVariation(perf.cumulativeTime);

    return {
      avgThroughput,
      avgLatency,
      avgCumulativeTime,
      variance,
      sampleCount: perf.cumulativeTime.length,
      perf,
    };
  }

  estimateTypicalLatency() {
    if (!this.performanceHistory || this.performanceHistory.length === 0) {
      return 1000;
    }
    const recent = this.performanceHistory
      .slice(-Math.min(this.performanceHistory.length, 30))
      .map((point) => point.avgLatency)
      .filter((value) => Number.isFinite(value) && value > 0);

    if (recent.length === 0) {
      return 1000;
    }

    const sum = recent.reduce((total, value) => total + value, 0);
    return sum / recent.length;
  }

  getScaleUpGuardrails(currentThreads, nextThreads) {
    const thermalConstant = this.estimateThermalTimeConstant();
    const baselineStats = this.getThreadPerformanceStats(currentThreads);
    const nextStats = this.getThreadPerformanceStats(nextThreads);

    const sampleDensity = Math.max(
      baselineStats?.sampleCount || 0,
      nextStats?.sampleCount || 0,
      Math.ceil(this.performanceHistory.length * 0.1)
    );
    const samplesRequired = Math.max(
      2,
      Math.min(25, Math.ceil(Math.sqrt(sampleDensity + nextThreads)))
    );

    const demandPattern = this.getRecentDemandPattern();
    const variation =
      baselineStats?.variance ??
      nextStats?.variance ??
      1 / Math.max(currentThreads + nextThreads, 2);
    const demandOffset = demandPattern.avgUtilization || 0;
    const fallbackTolerance = 1 / Math.max(currentThreads + nextThreads, 2);
    const degradationTolerance = Math.max(
      fallbackTolerance,
      variation + demandOffset / Math.max(nextThreads || 1, 1)
    );

    const avgLatencyMs =
      baselineStats?.avgLatency ||
      nextStats?.avgLatency ||
      this.estimateTypicalLatency();
    const latencyWindow = avgLatencyMs * Math.max(samplesRequired, 2);
    const dynamicWindow = Math.max(
      latencyWindow,
      this.scaleCooldownMs * 0.5,
      thermalConstant * 0.75,
      1000
    );
    const cappedWindow = Math.min(
      dynamicWindow,
      Math.max(this.minDataWindow * 0.5, 5000)
    );
    const validationWindowMs = Math.max(cappedWindow, this.scaleCooldownMs);

    return {
      validationWindowMs,
      samplesRequired,
      degradationTolerance,
    };
  }

  noteScaleUpValidation(previousThreads, nextThreads, guardrails = null) {
    if (
      typeof previousThreads !== "number" ||
      typeof nextThreads !== "number"
    ) {
      return;
    }

    if (nextThreads > previousThreads) {
      const guardrailSnapshot =
        guardrails || this.getScaleUpGuardrails(previousThreads, nextThreads);
      this.pendingScaleUpValidation = {
        targetThreads: nextThreads,
        baselineThreads: previousThreads,
        startedAt: Date.now(),
        guardrails: guardrailSnapshot,
      };
      return;
    }

    if (
      this.pendingScaleUpValidation &&
      nextThreads <= this.pendingScaleUpValidation.baselineThreads
    ) {
      this.pendingScaleUpValidation = null;
    }
  }

  isAwaitingScaleUpValidation() {
    if (
      !this.pendingScaleUpValidation ||
      this.pendingScaleUpValidation.targetThreads !==
        this.lastRecommendedThreads
    ) {
      return false;
    }

    const stats =
      this.performanceByThreadCount[
        this.pendingScaleUpValidation.targetThreads
      ];
    const guardrails = this.pendingScaleUpValidation.guardrails;
    const samplesRequired = guardrails?.samplesRequired || 0;
    if (
      stats &&
      stats.cumulativeTime.length >= samplesRequired &&
      stats.throughput.length >= samplesRequired
    ) {
      return false;
    }

    const elapsed = Date.now() - this.pendingScaleUpValidation.startedAt;
    const validationWindow =
      guardrails?.validationWindowMs || this.scaleCooldownMs;
    return elapsed < validationWindow;
  }

  evaluateScaleUpValidation() {
    if (!this.pendingScaleUpValidation) {
      return null;
    }

    const { targetThreads, baselineThreads, startedAt, guardrails } =
      this.pendingScaleUpValidation;
    const stats = this.performanceByThreadCount[targetThreads];
    const samplesRequired = guardrails?.samplesRequired || 0;

    if (
      !stats ||
      stats.cumulativeTime.length < samplesRequired ||
      stats.throughput.length < samplesRequired
    ) {
      const validationWindow =
        guardrails?.validationWindowMs || this.scaleCooldownMs;
      if (Date.now() - startedAt > validationWindow) {
        this.pendingScaleUpValidation = null;
      }
      return null;
    }

    this.pendingScaleUpValidation = null;
    const targetAvg = this.calculateAverage(stats.cumulativeTime);
    const baselineStats = this.performanceByThreadCount[baselineThreads];
    const baselineAvg = baselineStats
      ? this.calculateAverage(baselineStats.cumulativeTime)
      : null;

    if (
      baselineAvg &&
      guardrails &&
      targetAvg > baselineAvg * (1 + guardrails.degradationTolerance)
    ) {
      return {
        forceBaseline: true,
        baselineThreads: baselineThreads,
        targetThreads,
      };
    }

    return { passed: true };
  }

  historicalDataSupportsScaleUp(
    currentThreads,
    nextThreads,
    guardrailsOverride = null
  ) {
    const guardrails =
      guardrailsOverride ||
      this.getScaleUpGuardrails(currentThreads, nextThreads);
    const currentStats = this.getThreadPerformanceStats(currentThreads);
    const nextStats = this.getThreadPerformanceStats(nextThreads);

    if (
      !currentStats ||
      currentStats.sampleCount < (guardrails.samplesRequired || 0)
    ) {
      return true;
    }
    if (
      !nextStats ||
      nextStats.sampleCount < (guardrails.samplesRequired || 0)
    ) {
      return true;
    }

    const currentAvg = currentStats.avgCumulativeTime;
    const nextAvg = nextStats.avgCumulativeTime;
    if (!currentAvg || !nextAvg) {
      return true;
    }

    return nextAvg <= currentAvg * (1 + guardrails.degradationTolerance);
  }

  canScaleUpGradually(currentThreads, nextThreads, guardrailsOverride = null) {
    const guardrails =
      guardrailsOverride ||
      this.getScaleUpGuardrails(currentThreads, nextThreads);

    if (this.isAwaitingScaleUpValidation()) {
      return false;
    }

    if (
      !this.historicalDataSupportsScaleUp(
        currentThreads,
        nextThreads,
        guardrails
      )
    ) {
      return false;
    }

    const now = Date.now();
    const cooldownWindow = Math.max(
      guardrails.validationWindowMs,
      this.scaleCooldownMs
    );
    if (now - this.lastScalingDecision < cooldownWindow) {
      return false;
    }

    return true;
  }

  getOptimalMaxThreads() {
    if (this.useOptimalMaxThreads) {
      // If optimal hasn't been determined yet, return null to indicate no cap
      return this.optimalMaxThreads;
    }
    return this.defaultMaxThreads;
  }

  predictLoadWithThreads(currentMetrics, targetThreads) {
    if (this.performanceHistory.length < 10) {
      const threadMultiplier =
        targetThreads / Math.max(this.lastRecommendedThreads, 1);
      const latest = currentMetrics[currentMetrics.length - 1] || {};

      return {
        predictedCpuUsage: (latest.avgCpuUsage || 50) * threadMultiplier,
        predictedCpuTemp:
          (latest.avgCpuTemp || 70) + (threadMultiplier - 1) * 5,
        predictedMemoryUsage:
          (latest.avgMemoryUsage || 40) * Math.sqrt(threadMultiplier),
        confidence: 0.3,
        basedOn: "conservative_estimate",
      };
    }

    const latest = currentMetrics[currentMetrics.length - 1] || {};
    const similarPeriods = this.performanceHistory.filter((point) => {
      return (
        point.systemStable &&
        Math.abs((point.cpuUsage || 0) - (latest.avgCpuUsage || 0)) < 20 &&
        Math.abs((point.cpuTemp || 0) - (latest.avgCpuTemp || 0)) < 10
      );
    });

    if (similarPeriods.length < 3) {
      return this.estimateLoadFromThreadScaling(currentMetrics, targetThreads);
    }

    const threadLoadRelationship =
      this.analyzeThreadLoadRelationship(similarPeriods);

    return {
      predictedCpuUsage: this.predictMetricWithThreads(
        latest.avgCpuUsage,
        targetThreads,
        threadLoadRelationship.cpu
      ),
      predictedCpuTemp: this.predictMetricWithThreads(
        latest.avgCpuTemp,
        targetThreads,
        threadLoadRelationship.temp
      ),
      predictedMemoryUsage: this.predictMetricWithThreads(
        latest.avgMemoryUsage,
        targetThreads,
        threadLoadRelationship.memory
      ),
      confidence: Math.min(similarPeriods.length / 10, 0.9),
      basedOn: `${similarPeriods.length}_similar_periods`,
    };
  }

  analyzeThreadLoadRelationship(dataPoints) {
    if (dataPoints.length < 3) {
      return { cpu: 1.2, temp: 1.1, memory: 1.15 };
    }

    const relationships = { cpu: [], temp: [], memory: [] };

    for (let i = 1; i < dataPoints.length; i++) {
      const prev = dataPoints[i - 1];
      const curr = dataPoints[i];

      if (curr.concurrentThreads !== prev.concurrentThreads) {
        const threadDiff = curr.concurrentThreads - prev.concurrentThreads;
        if (threadDiff !== 0) {
          relationships.cpu.push((curr.cpuUsage - prev.cpuUsage) / threadDiff);
          relationships.temp.push((curr.cpuTemp - prev.cpuTemp) / threadDiff);
          relationships.memory.push(
            (curr.memoryUsage - prev.memoryUsage) / threadDiff
          );
        }
      }
    }

    return {
      cpu: this.calculateMedian(relationships.cpu) || 3,
      temp: this.calculateMedian(relationships.temp) || 1,
      memory: this.calculateMedian(relationships.memory) || 2,
    };
  }

  predictMetricWithThreads(currentValue, targetThreads, impactPerThread) {
    const threadDiff = targetThreads - this.lastRecommendedThreads;
    return (currentValue || 0) + threadDiff * impactPerThread;
  }

  calculateMedian(arr) {
    if (arr.length === 0) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  calculateAverage(arr) {
    if (!arr || arr.length === 0) return null;
    const filtered = arr.filter((value) => Number.isFinite(value));
    if (filtered.length === 0) return null;
    const sum = filtered.reduce((a, b) => a + b, 0);
    return sum / filtered.length;
  }

  computeCoefficientOfVariation(values) {
    if (!values || values.length < 2) return 0;
    const filtered = values.filter((value) => Number.isFinite(value));
    if (filtered.length < 2) {
      return 0;
    }

    const mean =
      filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
    if (mean === 0) {
      return 0;
    }

    const variance =
      filtered.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
      filtered.length;
    const stdDev = Math.sqrt(variance);
    return stdDev / mean;
  }

  estimateLoadFromThreadScaling(currentMetrics, targetThreads) {
    const latest = currentMetrics[currentMetrics.length - 1] || {};
    const threadRatio =
      targetThreads / Math.max(this.lastRecommendedThreads, 1);

    const cpuScaling = Math.pow(threadRatio, 0.8);
    const tempScaling = Math.pow(threadRatio, 0.6);
    const memoryScaling = Math.pow(threadRatio, 0.7);

    return {
      predictedCpuUsage: (latest.avgCpuUsage || 50) * cpuScaling,
      predictedCpuTemp: (latest.avgCpuTemp || 70) + (tempScaling - 1) * 15,
      predictedMemoryUsage: (latest.avgMemoryUsage || 40) * memoryScaling,
      confidence: 0.5,
      basedOn: "general_scaling_patterns",
    };
  }

  async findOptimalThreadCount(
    rawSamples,
    operationMixes,
    maxThreads = null,
    emergencyThresholds = { cpu: 95, temp: 95, gpu: 95 },
    isEmergency = false,
    isNearEmergency = false,
    operationMixWithContext = null
  ) {
    let effectiveMaxThreads;
    if (maxThreads !== null) {
      effectiveMaxThreads = maxThreads;
    } else if (this.useOptimalMaxThreads) {
      // If optimal hasn't been determined yet, scale up indefinitely
      // Once optimal is determined, use that value
      const optimal = this.getOptimalMaxThreads();
      effectiveMaxThreads = optimal !== null ? optimal : Infinity;
    } else {
      effectiveMaxThreads = this.defaultMaxThreads;
    }

    let bestThreads = 1;
    let bestScore = -Infinity;
    const latest = rawSamples[rawSamples.length - 1] || {};

    const currentIntensity = operationMixWithContext?.currentIntensity || 0;
    const totalOperations = operationMixWithContext?.totalOperations || 0;

    const intensityFactor = Math.max(
      0.5,
      Math.min(1.5, 1.0 - currentIntensity * 0.3)
    );
    const adjustedMaxThreads = Math.floor(
      effectiveMaxThreads * intensityFactor
    );

    const prev = rawSamples[rawSamples.length - 2] || {};
    const deltaTemp = (latest.avgCpuTemp || 0) - (prev.avgCpuTemp || 0);
    const deltaCPU = (latest.avgCpuUsage || 0) - (prev.avgCpuUsage || 0);

    const tempWindow = rawSamples.slice(-5);
    const rollingMaxTemp = Math.max(
      ...tempWindow.map((s) => s.avgCpuTemp || 0)
    );

    const approaching =
      rollingMaxTemp > this.emergencyAbsoluteLimits.cpuTemp * 0.8 ||
      (latest.avgCpuUsage || 0) > this.emergencyAbsoluteLimits.cpuUsage * 0.8 ||
      deltaTemp > 3;

    if (approaching) {
      const objectiveFunction = async ({ threads }) => {
        let reward = latest.queuePressure || 0;
        const penalty =
          4 * Math.max(0, rollingMaxTemp - 80) ** 2 +
          3 * Math.max(0, (latest.avgCpuUsage || 0) - 90) ** 2;
        reward -= penalty;
        if (deltaTemp > 3) reward -= 20 * (deltaTemp - 3);
        if (currentIntensity > 0.7) reward -= 10 * currentIntensity;
        return reward;
      };
      await this.bayes.optimize(objectiveFunction, this.bayesSearchSpace, 1);
      const bestParams = this.bayes.getBestParams();
      if (bestParams && bestParams.threads < bestThreads) {
        bestThreads = bestParams.threads;
        bestScore -= 1;
      }
    }

    const stableWindow = rawSamples.slice(-20);
    const stableTempThreshold = this.highThresholds.cpuTemp - 10;
    const stableCpuThreshold = this.highThresholds.cpuUsage - 15;
    const allStable = stableWindow.every(
      (s) =>
        (s.avgCpuTemp || 0) < stableTempThreshold &&
        (s.avgCpuUsage || 0) < stableCpuThreshold
    );
    if (!allStable && bestThreads > this.lastRecommendedThreads) {
      bestThreads = this.lastRecommendedThreads;
    }

    const emergencyOverride = this.handleEmergencyAdaptation(
      isEmergency,
      isNearEmergency
    );
    if (emergencyOverride !== null) {
      const previousThreads = this.lastRecommendedThreads;
      this.afterScalingDecision(
        rawSamples,
        emergencyOverride,
        previousThreads,
        null
      );
      const finalEmergencyOverride = Math.max(
        1,
        Math.min(adjustedMaxThreads, emergencyOverride)
      );

      return {
        recommendedThreads: finalEmergencyOverride,
        reason: "emergency_override",
        confidence: 1.0,
        intensityContext: {
          currentIntensity,
          totalOperations,
          adjustedMaxThreads,
        },
      };
    }

    const validationOverride = this.evaluateScaleUpValidation();
    if (
      validationOverride?.forceBaseline &&
      this.lastRecommendedThreads > validationOverride.baselineThreads
    ) {
      const fallbackThreads = Math.max(
        1,
        Math.min(adjustedMaxThreads, validationOverride.baselineThreads)
      );
      const previousThreads = this.lastRecommendedThreads;
      this.afterScalingDecision(
        rawSamples,
        fallbackThreads,
        previousThreads,
        null
      );

      return {
        recommendedThreads: fallbackThreads,
        reason: `validation_regression_target_${validationOverride.targetThreads}`,
        confidence: 0.85,
        intensityContext: {
          currentIntensity,
          totalOperations,
          adjustedMaxThreads,
        },
      };
    }

    let backlog = 0;
    const latestPerformance =
      this.performanceHistory[this.performanceHistory.length - 1];
    if (latestPerformance) {
      const utilization = latestPerformance.utilization || 0;
      const queuePressure = latestPerformance.queuePressure || 0;
      backlog =
        latestPerformance.backlog ??
        queuePressure + latestPerformance.activeThreads;
      const hasUnmetDemand =
        backlog >= this.lastRecommendedThreads ||
        (queuePressure > 0 &&
          latestPerformance.activeThreads >= this.lastRecommendedThreads);

      const demandDecision = this.makeScalingDecision(
        latest,
        utilization,
        hasUnmetDemand,
        queuePressure,
        adjustedMaxThreads,
        operationMixWithContext,
        backlog
      );

      if (
        demandDecision.scaleType === "up" ||
        demandDecision.scaleType === "down"
      ) {
        const previousThreads = this.lastRecommendedThreads;
        this.afterScalingDecision(
          rawSamples,
          demandDecision.threads,
          previousThreads,
          demandDecision.guardrails || null
        );
        return {
          recommendedThreads: demandDecision.threads,
          reason: demandDecision.reason,
          confidence: 0.8,
          intensityContext: demandDecision.intensityContext,
        };
      }
    }

    const recommendation = await this.recommendThreadCount(
      rawSamples,
      this.useOptimalMaxThreads
        ? this.optimalMaxThreads || adjustedMaxThreads
        : adjustedMaxThreads
    );

    const recommended = recommendation.threads;
    const previousThreads = this.lastRecommendedThreads;
    this.afterScalingDecision(
      rawSamples,
      recommended,
      previousThreads,
      recommendation.guardrails || null
    );

    const finalRecommended = Math.max(
      1,
      Math.min(adjustedMaxThreads, recommended)
    );

    const reason = allStable
      ? `conservative_stable_increase_intensity_${currentIntensity.toFixed(2)}`
      : `conservative_hold_intensity_${currentIntensity.toFixed(2)}`;

    return {
      recommendedThreads: finalRecommended,
      reason: reason,
      confidence: allStable ? 0.9 : 0.7,
      intensityContext: {
        currentIntensity,
        totalOperations,
        adjustedMaxThreads,
      },
    };
  }

  afterScalingDecision(
    rawSamples,
    recommendedThreads,
    previousThreads,
    guardrails = null
  ) {
    if (recommendedThreads === undefined) {
      return;
    }

    const prior =
      typeof previousThreads === "number"
        ? previousThreads
        : this.lastRecommendedThreads;

    if (prior !== recommendedThreads) {
      this.lastScalingDecision = Date.now();
      this.noteScaleUpValidation(prior, recommendedThreads, guardrails);
    }

    this.lastRecommendedThreads = recommendedThreads;
  }

  async recommendThreadCount(currentMetrics, maxThreads = 12) {
    const scalingRecommendation =
      await this.usageHistoryManager.getScalingRecommendations({
        highCpuUsage: this.highThresholds.cpuUsage,
        highTemp: this.highThresholds.cpuTemp,
        emergencyCpuUsage: this.emergencyAbsoluteLimits.cpuUsage,
        emergencyTemp: this.emergencyAbsoluteLimits.cpuTemp,
      });
    const usageAnalysis = await this.usageHistoryManager.analyzeUsageTrends();

    let recommended = this.lastRecommendedThreads;

    switch (scalingRecommendation.action) {
      case "scale_down":
        if (scalingRecommendation.urgency === "high") {
          recommended = Math.max(1, this.lastRecommendedThreads - 1);
        } else if (scalingRecommendation.urgency === "medium") {
          recommended = Math.max(1, this.lastRecommendedThreads - 1);
        }
        break;

      case "scale_up":
        if (
          this.lastRecommendedThreads < maxThreads &&
          scalingRecommendation.confidence > 0.5
        ) {
          recommended = Math.min(maxThreads, this.lastRecommendedThreads + 1);
        }
        break;

      case "maintain":
      default:
        recommended = this.lastRecommendedThreads;
        break;
    }

    if (
      usageAnalysis.hasEnoughData &&
      usageAnalysis.operationMixAnalysis?.hasChanges
    ) {
      const intensityChange =
        usageAnalysis.operationMixAnalysis.changes[0]?.intensityChange || 0;

      if (intensityChange > 0) {
        recommended = Math.max(1, recommended - 1);
      } else if (intensityChange < 0) {
        recommended = Math.min(maxThreads, recommended + 1);
      }
    }

    let guardrails = null;
    if (recommended > this.lastRecommendedThreads) {
      const computedGuardrails = this.getScaleUpGuardrails(
        this.lastRecommendedThreads,
        recommended
      );
      if (
        !this.canScaleUpGradually(
          this.lastRecommendedThreads,
          recommended,
          computedGuardrails
        )
      ) {
        recommended = this.lastRecommendedThreads;
      } else {
        guardrails = computedGuardrails;
      }
    }

    const finalThreads = Math.max(1, Math.min(maxThreads, recommended));
    if (finalThreads <= this.lastRecommendedThreads) {
      guardrails = null;
    }

    return { threads: finalThreads, guardrails };
  }

  makeScalingDecision(
    latest,
    utilization,
    hasUnmetDemand,
    queuePressure,
    maxThreads,
    operationMixWithContext = null,
    backlogContext = 0
  ) {
    const currentThreads = this.lastRecommendedThreads;
    const currentIntensity = operationMixWithContext?.currentIntensity || 0;
    const totalOperations = operationMixWithContext?.totalOperations || 0;
    const awaitingValidation = this.isAwaitingScaleUpValidation();

    let effectiveMaxThreads;
    if (this.useOptimalMaxThreads) {
      // If optimal hasn't been determined yet, scale up indefinitely
      // Once optimal is determined, use that value
      effectiveMaxThreads =
        this.optimalMaxThreads !== null ? this.optimalMaxThreads : Infinity;
    } else {
      effectiveMaxThreads = maxThreads;
    }

    const intensityFactor = Math.max(
      0.5,
      Math.min(1.5, 1.0 - currentIntensity * 0.3)
    );
    const adjustedMaxThreads = Math.floor(
      effectiveMaxThreads * intensityFactor
    );

    if (hasUnmetDemand || utilization > 0.8) {
      if (currentThreads < adjustedMaxThreads) {
        const nextThreads = currentThreads + 1;
        const guardrails = this.getScaleUpGuardrails(
          currentThreads,
          nextThreads
        );
        if (
          !this.canScaleUpGradually(currentThreads, nextThreads, guardrails)
        ) {
          return {
            threads: currentThreads,
            scaleType: "none",
            reason: awaitingValidation
              ? "awaiting_scale_up_validation_window"
              : "historical_block_scale_up",
            intensityContext: {
              currentIntensity,
              totalOperations,
              adjustedMaxThreads,
            },
            guardrails,
          };
        }

        const intensityReason =
          currentIntensity > 0.7
            ? "high_intensity_operations"
            : "normal_operations";
        return {
          threads: nextThreads,
          scaleType: "up",
          reason: hasUnmetDemand
            ? `unmet_demand_queue_${queuePressure}_${intensityReason}`
            : `high_utilization_${(utilization * 100).toFixed(
                0
              )}%_${intensityReason}`,
          intensityContext: {
            currentIntensity,
            totalOperations,
            adjustedMaxThreads,
            backlog: backlogContext,
            queuePressure,
          },
          guardrails,
        };
      }
    }

    const downThreshold = currentIntensity > 0.7 ? 0.4 : 0.3;
    if (utilization < downThreshold && queuePressure === 0) {
      const recentDemand = this.getRecentDemandPattern();
      if (!recentDemand.hasRecentHighDemand && currentThreads > 1) {
        return {
          threads: currentThreads - 1,
          scaleType: "down",
          reason: `low_utilization_${(utilization * 100).toFixed(
            0
          )}%_intensity_${currentIntensity.toFixed(2)}_no_recent_demand`,
          intensityContext: {
            currentIntensity,
            totalOperations,
            downThreshold: downThreshold * 100,
            backlog: backlogContext,
            queuePressure,
          },
          guardrails: null,
        };
      }
    }

    const maintainReasonPrefix = awaitingValidation
      ? "validation_hold"
      : "maintain";

    return {
      threads: currentThreads,
      scaleType: "none",
      reason: `${maintainReasonPrefix}_utilization_${(
        utilization * 100
      ).toFixed(0)}%_intensity_${currentIntensity.toFixed(2)}`,
      intensityContext: {
        currentIntensity,
        totalOperations,
        adjustedMaxThreads,
        backlog: backlogContext,
        queuePressure,
      },
      guardrails: null,
    };
  }

  getRecentDemandPattern() {
    const recentWindow = 5 * 60 * 1000;
    const now = Date.now();
    const recentDemand = this.demandHistory.filter(
      (point) => now - point.timestamp < recentWindow
    );

    if (recentDemand.length === 0) {
      return { hasRecentHighDemand: false, avgUtilization: 0 };
    }

    const hasRecentHighDemand = recentDemand.some(
      (point) => point.hasUnmetDemand || point.utilization > 0.7
    );

    const avgUtilization =
      recentDemand.reduce((sum, point) => sum + point.utilization, 0) /
      recentDemand.length;

    return { hasRecentHighDemand, avgUtilization };
  }

  handleEmergencyAdaptation(isEmergency, isNearEmergency) {
    if (isEmergency) {
      this.consecutiveEmergencies++;
      if (this.consecutiveEmergencies > 3) {
        this.lastRecommendedThreads = 1;
        this.lastStableTime = null;
        return 1;
      }
    } else if (isNearEmergency) {
      this.consecutiveEmergencies++;
      if (this.consecutiveEmergencies > 10) {
        this.lastRecommendedThreads = 1;
        this.lastStableTime = null;
        return 1;
      }
    } else {
      if (!this.lastStableTime) this.lastStableTime = Date.now();
      if (Date.now() - this.lastStableTime > 30000) {
        this.consecutiveEmergencies = 0;
        this.lastStableTime = Date.now();
      }
    }
    return null;
  }

  estimateThermalTimeConstant() {
    if (!this.performanceHistory || this.performanceHistory.length < 10)
      return 5000;
    let totalTime = 0,
      count = 0;
    for (let i = 1; i < this.performanceHistory.length; i++) {
      const prev = this.performanceHistory[i - 1];
      const curr = this.performanceHistory[i];
      if (
        curr.concurrentThreads > prev.concurrentThreads &&
        curr.cpuTemp > prev.cpuTemp
      ) {
        const deltaT = curr.cpuTemp - prev.cpuTemp;
        const deltaTime = curr.timestamp - prev.timestamp;
        if (deltaT > 2 && deltaTime > 0) {
          totalTime += deltaTime;
          count++;
        }
      }
    }
    if (count === 0) return 5000;
    return Math.max(2000, Math.min(20000, Math.round(totalTime / count)));
  }
}
