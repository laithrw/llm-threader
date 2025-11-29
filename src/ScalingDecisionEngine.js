import { BayesianOptimizer } from "bayesian-optimizer";
import { UsageHistoryManager } from "./UsageHistoryManager.js";
import scalingDatabase from "./scalingDatabase.js";
import { PIDController } from "./utils/PIDController.js";
import { calculateMedian } from "./utils/mathUtils.js";
import { RewardCalculator } from "./utils/rewardCalculator.js";

export class ScalingDecisionEngine {
  constructor(options = {}) {
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

    this.lastRecommendedThreads = 1;
    this.lastScalingDecision = Date.now();

    this.demandHistory = [];
    this.maxDemandHistory = 50;

    this.operationIntensityProfiles = {};

    this.maxThreads =
      Number.isFinite(options.maxThreads) && options.maxThreads > 0
        ? options.maxThreads
        : null;

    this.pid = new PIDController({
      kp: options.kp || 0.5,
      ki: options.ki || 0.05,
      kd: options.kd || 0.1,
      setpoint: options.setpoint || 90,
      outputMin: 1,
      outputMax: Number.isFinite(this.maxThreads) ? this.maxThreads : 12,
    });

    this.rewardCalculator = new RewardCalculator(
      this.highThresholds,
      this.emergencyAbsoluteLimits
    );
    this.lastTemp = null;
    this.tempDeltas = [];
    this.tempWindow = 10;

    this.bayes = new BayesianOptimizer({
      exploration: 0.02,
      numCandidates: 20,
    });

    this.minCooldown = Math.min(10000, 2 * this.estimateThermalTimeConstant());
    this.scaleCooldownMs = options.scaleCooldownMs || this.minCooldown || 10000;
    this.lastScalingDecision = Date.now() - this.scaleCooldownMs;
    this.consecutiveEmergencies = 0;
    this.lastStableTime = Date.now();

    this.usageHistoryManager = new UsageHistoryManager({
      maxHistoryAgeMinutes: options.maxHistoryAgeMinutes || 5,
      maxDataPoints: options.maxDataPoints || 300,
    });
    if (
      Number.isFinite(options.scalingHistoryRetentionHours) &&
      options.scalingHistoryRetentionHours > 0
    ) {
      scalingDatabase.setScalingRetentionHours(
        options.scalingHistoryRetentionHours
      );
    }
    this._loadScalingHistory();
  }

  _loadScalingHistory() {
    if (!scalingDatabase.available) {
      return;
    }
    try {
      const history = scalingDatabase.getScalingHistory(24);
      history.forEach((entry) => {
        this.performanceHistory.push({
          timestamp: entry.timestamp,
          concurrentThreads: entry.thread_count,
          cpuUsage: entry.cpu_usage,
          cpuTemp: entry.temperature,
          memoryUsage: entry.memory_usage,
          gpuUsage: entry.gpu_usage,
          stable: true,
        });
      });
    } catch (error) {
      // Best effort; keep memory history empty on failure
      void error;
    }
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
    backlogSize = null,
    p95Latency = null
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
      activeThreads,
      queuePressure,
      operationMix: { ...operationMix },
      operationIntensity: operationMixContext?.currentIntensity || 0,
      totalOperations: operationMixContext?.totalOperations || 0,
      stable: true,
      utilization: activeThreads / Math.max(currentThreads, 1),
      throughput,
      avgLatency,
      p95Latency,
      backlog: backlogSize,
    };

    this.performanceHistory.push(performancePoint);
    if (this.performanceHistory.length > this.maxPerformanceHistory) {
      this.performanceHistory.shift();
    }

    if (scalingDatabase.available) {
      scalingDatabase.addScalingHistory({
        timestamp: performancePoint.timestamp,
        threadCount: currentThreads,
        cpuUsage,
        gpuUsage,
        memoryUsage,
        temperature: cpuTemp,
        activeOperations: activeThreads,
        queueLength: queuePressure,
        scalingDecision: "",
        pidOutput: 0,
        bayesOptimization: 0,
        demandScore: queuePressure,
      });
    }

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

    this.usageHistoryManager.addUsageData({
      cpuUsage,
      cpuTemp,
      memoryUsage,
      gpuTemp,
      gpuUsage,
      concurrentThreads: currentThreads,
      activeThreads,
      queuePressure,
      operationMix: { ...operationMix },
      operationIntensity: operationMixContext?.currentIntensity || 0,
    });
  }

  updateOperationIntensityProfiles() {
    // Placeholder for DB-backed profiles in the reference implementation.
    return this.operationIntensityProfiles;
  }

  getExplorationCeiling(queuePressure = 0, activeThreads = 0) {
    if (Number.isFinite(this.maxThreads)) {
      return this.maxThreads;
    }
    const demandPush =
      queuePressure + activeThreads + this.lastRecommendedThreads;
    return Math.max(4, Math.ceil(demandPush * 2));
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
      cpu: calculateMedian(relationships.cpu) || 3,
      temp: calculateMedian(relationships.temp) || 1,
      memory: calculateMedian(relationships.memory) || 2,
    };
  }

  predictMetricWithThreads(currentValue, targetThreads, impactPerThread) {
    const threadDiff = targetThreads - this.lastRecommendedThreads;
    return (currentValue || 0) + threadDiff * impactPerThread;
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

    const pidThreads = this.pid.update(
      currentMetrics[currentMetrics.length - 1]?.avgCpuUsage ||
        currentMetrics[currentMetrics.length - 1]?.cpuLoad ||
        this.lastRecommendedThreads
    );

    const blended = Math.round(
      0.5 * recommended + 0.5 * Math.max(1, Math.min(maxThreads, pidThreads))
    );

    return { threads: Math.max(1, Math.min(maxThreads, blended)) };
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

    const intensityFactor = Math.max(
      0.5,
      Math.min(1.5, 1.0 - currentIntensity * 0.3)
    );
    const adjustedMaxThreads = Math.floor(maxThreads * intensityFactor);

    if (hasUnmetDemand || utilization > 0.8) {
      if (currentThreads < adjustedMaxThreads) {
        const intensityReason =
          currentIntensity > 0.7
            ? "high_intensity_operations"
            : "normal_operations";
        return {
          threads: currentThreads + 1,
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
        };
      }
    }

    return {
      threads: currentThreads,
      scaleType: "none",
      reason: `maintain_utilization_${(utilization * 100).toFixed(
        0
      )}%_intensity_${currentIntensity.toFixed(2)}`,
      intensityContext: {
        currentIntensity,
        totalOperations,
        adjustedMaxThreads,
        backlog: backlogContext,
        queuePressure,
      },
    };
  }

  detectAnomaly(currentTemp) {
    if (this.lastTemp !== null) {
      const delta = currentTemp - this.lastTemp;
      this.tempDeltas.push(delta);
      if (this.tempDeltas.length > this.tempWindow) this.tempDeltas.shift();
      const mean =
        this.tempDeltas.reduce((a, b) => a + b, 0) / this.tempDeltas.length;
      const std = Math.sqrt(
        this.tempDeltas.reduce((a, b) => a + (b - mean) ** 2, 0) /
          this.tempDeltas.length
      );
      const z = std > 0 ? (delta - mean) / std : 0;
      if (z > 2.5) {
        return true;
      }
    }
    this.lastTemp = currentTemp;
    return false;
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

  generateReasonString(
    threads,
    prediction,
    queuePressure,
    utilization = 0,
    hasUnmetDemand = false
  ) {
    const reasons = [];

    if (threads > this.lastRecommendedThreads) {
      reasons.push(`scale up to ${threads}`);
      if (hasUnmetDemand)
        reasons.push(`unmet demand (queue: ${queuePressure})`);
      if (utilization > 0.8)
        reasons.push(`high utilization: ${(utilization * 100).toFixed(0)}%`);
      if (prediction.confidence > 0.7)
        reasons.push(
          `high confidence: ${(prediction.confidence * 100).toFixed(0)}%`
        );
    } else if (threads < this.lastRecommendedThreads) {
      reasons.push(`scale down to ${threads}`);
      if (utilization < 0.3)
        reasons.push(`low utilization: ${(utilization * 100).toFixed(0)}%`);
      if (queuePressure === 0) reasons.push("no queue pressure");
    } else {
      reasons.push(`maintain ${threads} threads`);
      reasons.push(`utilization: ${(utilization * 100).toFixed(0)}%`);
      if (queuePressure > 0) reasons.push(`queue: ${queuePressure}`);
    }

    return `Demand-driven analysis: ${reasons.join(
      ", "
    )} | Predicted: CPU ${prediction.predictedCpuUsage?.toFixed(
      1
    )}%, Temp ${prediction.predictedCpuTemp?.toFixed(1)}°C`;
  }

  async findOptimalThreadCount(
    rawSamples,
    _operationMixes,
    maxThreads = null,
    _emergencyThresholds = { cpu: 95, temp: 95, gpu: 95 },
    isEmergency = false,
    isNearEmergency = false,
    operationMixWithContext = null
  ) {
    this.updateOperationIntensityProfiles(rawSamples);

    const effectiveMaxThreads =
      maxThreads !== null && maxThreads !== undefined
        ? maxThreads
        : this.getExplorationCeiling(
            this.performanceHistory[this.performanceHistory.length - 1]
              ?.queuePressure || 0,
            this.performanceHistory[this.performanceHistory.length - 1]
              ?.activeThreads || 0
          );

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

    const tempWindow = rawSamples.slice(-5);
    const rollingMaxTemp = Math.max(
      ...tempWindow.map((s) => s.avgCpuTemp || 0)
    );

    const gpuTemp = latest.avgGpuTemp || latest.gpuTemp || 0;
    const gpuUsage = latest.avgGpuUsage || latest.gpuUsage || 0;

    const latestPerformance =
      this.performanceHistory[this.performanceHistory.length - 1];
    const queuePressure = latestPerformance?.queuePressure || 0;
    const backlogRaw =
      latestPerformance?.backlog ??
      queuePressure + (latestPerformance?.activeThreads || 0);
    const backlog = Math.max(backlogRaw || 0, queuePressure + 1);
    const utilization = latestPerformance?.utilization || 0;
    const throughput = latestPerformance?.throughput || 0;
    const latencyMs =
      latestPerformance?.p95Latency ||
      latestPerformance?.avgLatency ||
      this.estimateTypicalLatency();

    // Emergency clamp if above hard limits
    const isHardEmergency =
      (latest.avgCpuTemp || 0) >= this.emergencyAbsoluteLimits.cpuTemp ||
      (latest.avgCpuUsage || 0) >= this.emergencyAbsoluteLimits.cpuUsage ||
      gpuTemp >= this.emergencyAbsoluteLimits.gpuTemp ||
      gpuUsage >= this.emergencyAbsoluteLimits.gpuUsage;
    if (isHardEmergency) {
      this.afterScalingDecision(rawSamples, 1);
      return {
        recommendedThreads: 1,
        reason: "hard_emergency_clamp",
        confidence: 1.0,
        intensityContext: {
          currentIntensity,
          totalOperations,
          adjustedMaxThreads,
        },
      };
    }

    // PID prior
    // Adjust PID ceiling to exploration ceiling for unbounded search
    this.pid.outputMax = Math.max(
      this.pid.outputMin,
      Number.isFinite(adjustedMaxThreads) ? adjustedMaxThreads : 12
    );
    const pidTarget = this.pid.update(latest.avgCpuUsage || 0);
    const searchMin = Math.max(1, pidTarget - 1);
    const searchMax = Math.max(
      searchMin + 1,
      Number.isFinite(adjustedMaxThreads)
        ? adjustedMaxThreads
        : searchMin + Math.max(3, Math.ceil(backlog))
    );

    // Bayesian objective grounded in reward
    const objectiveFunction = async ({ threads }) => {
      const prediction = this.predictLoadWithThreads(rawSamples, threads);
      const effectiveThroughput =
        throughput && this.lastRecommendedThreads > 0
          ? throughput * (threads / this.lastRecommendedThreads)
          : threads > 0 && latencyMs
          ? threads / Math.max(latencyMs / 1000, 0.001)
          : throughput || 0;
      const reward = this.rewardCalculator.computeReward({
        throughput: effectiveThroughput,
        latencyMs,
        backlog,
        predictedCpu: prediction.predictedCpuUsage,
        predictedTemp: prediction.predictedCpuTemp,
        predictedGpuUsage: prediction.predictedGpuUsage,
        predictedGpuTemp: prediction.predictedGpuTemp,
      });
      return reward;
    };

    await this.bayes.optimize(
      objectiveFunction,
      {
        threads: { min: searchMin, max: searchMax },
      },
      5
    );
    const bayesParams = this.bayes.getBestParams();
    const bayesThreads =
      bayesParams && bayesParams.threads
        ? Math.max(
            searchMin,
            Math.min(searchMax, Math.round(bayesParams.threads))
          )
        : pidTarget;

    const emergencyOverride = this.handleEmergencyAdaptation(
      isEmergency,
      isNearEmergency
    );
    if (emergencyOverride !== null) {
      this.afterScalingDecision(rawSamples, emergencyOverride);
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

    const stableWindow = rawSamples.slice(-20);
    const stableTempThreshold = this.highThresholds.cpuTemp - 10;
    const stableCpuThreshold = this.highThresholds.cpuUsage - 15;
    const allStable = stableWindow.every(
      (s) =>
        (s.avgCpuTemp || 0) < stableTempThreshold &&
        (s.avgCpuUsage || 0) < stableCpuThreshold
    );

    const hasUnmetDemand =
      backlog > this.lastRecommendedThreads ||
      (queuePressure > 0 &&
        (latestPerformance?.activeThreads || 0) >= this.lastRecommendedThreads);

    const demandDecision = this.makeScalingDecision(
      latest,
      utilization,
      hasUnmetDemand,
      queuePressure,
      adjustedMaxThreads,
      operationMixWithContext,
      backlog
    );

    const recommendation = await this.recommendThreadCount(
      rawSamples,
      adjustedMaxThreads
    );

    // Conservative check: only scale up if throughput gain outweighs latency/backlog penalties
    const proposedThreads =
      demandDecision.scaleType === "up" || demandDecision.scaleType === "down"
        ? demandDecision.threads
        : Math.round(
            0.2 * recommendation.threads + 0.5 * bayesThreads + 0.3 * pidTarget
          );

    const conservativeThreads =
      proposedThreads > this.lastRecommendedThreads
        ? Math.max(
            this.lastRecommendedThreads + 1,
            Math.min(proposedThreads, adjustedMaxThreads)
          )
        : proposedThreads;

    let recommended = Math.max(
      1,
      Math.min(adjustedMaxThreads, conservativeThreads)
    );
    // Avoid scaling higher than the current backlog; keep at least one thread alive
    // Hold scale-up until enough evidence on the current threads
    if (this.shouldHoldScaleUp(this.lastRecommendedThreads, recommended)) {
      recommended = this.lastRecommendedThreads;
    }

    const cappedByDemand = Math.max(
      1,
      Math.min(recommended, Math.max(backlog, 1))
    );
    this.afterScalingDecision(rawSamples, cappedByDemand);

    const reason =
      demandDecision.scaleType !== "none"
        ? demandDecision.reason
        : `bayes_pid_blend_intensity_${currentIntensity.toFixed(2)}`;

    return {
      recommendedThreads: cappedByDemand,
      reason,
      confidence: allStable ? 0.9 : 0.8,
      intensityContext: {
        currentIntensity,
        totalOperations,
        adjustedMaxThreads,
      },
    };
  }

  shouldHoldScaleUp(prevThreads, nextThreads) {
    if (nextThreads <= prevThreads) {
      return false;
    }
    const now = Date.now();
    const elapsed = now - this.lastScalingDecision;
    const expectedWindow = Math.max(
      this.scaleCooldownMs,
      Math.round(this.estimateTypicalLatency() * 2)
    );
    const samples = this.performanceHistory.filter(
      (p) => p.concurrentThreads === prevThreads
    );
    const requiredSamples = Math.max(
      1,
      Math.ceil(this.performanceHistory.length * 0.05)
    );

    const elapsedConfidence = Math.min(1, elapsed / expectedWindow);
    const sampleConfidence = Math.min(1, samples.length / requiredSamples);
    const confidence = 0.5 * elapsedConfidence + 0.5 * sampleConfidence;

    return confidence < 0.6;
  }

  afterScalingDecision(rawSamples, recommendedThreads) {
    this.updateOperationIntensityProfiles(rawSamples);
    if (recommendedThreads !== undefined) {
      this.lastScalingDecision = Date.now();
      this.lastRecommendedThreads = recommendedThreads;
      const latest = rawSamples[rawSamples.length - 1] || {};
      if (scalingDatabase.available) {
        scalingDatabase.addScalingHistory({
          timestamp: Date.now(),
          threadCount: recommendedThreads,
          cpuUsage: latest.avgCpuUsage ?? latest.cpuLoad ?? null,
          gpuUsage: latest.avgGpuUsage ?? latest.gpuUsage ?? null,
          memoryUsage: latest.avgMemoryUsage ?? latest.memoryUsage ?? null,
          temperature: latest.avgCpuTemp ?? latest.avgTemp ?? null,
          activeOperations: latest.activeThreads ?? null,
          queueLength: latest.queuePressure ?? null,
          scalingDecision: "recommended",
          pidOutput: recommendedThreads,
          bayesOptimization: this.bayes?.getBestParams?.()?.threads || null,
          demandScore: latest.queuePressure ?? null,
        });
      }
    }
  }

  getOperationIntensityProfiles() {
    return this.operationIntensityProfiles;
  }

  getPerformanceSummary() {
    const recentPoints = this.performanceHistory.slice(-10);
    if (recentPoints.length === 0) return null;

    const avgCpu =
      recentPoints.reduce((sum, p) => sum + (p.cpuUsage || 0), 0) /
      recentPoints.length;
    const avgTemp =
      recentPoints.reduce((sum, p) => sum + (p.cpuTemp || 0), 0) /
      recentPoints.length;
    const avgThreads =
      recentPoints.reduce((sum, p) => sum + p.concurrentThreads, 0) /
      recentPoints.length;

    return {
      averageCpuUsage: avgCpu,
      averageTemperature: avgTemp,
      averageThreads: avgThreads,
      dataPoints: recentPoints.length,
      historySize: this.performanceHistory.length,
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

  canAcceptEmbeddingRequest(queueLength) {
    return queueLength < 10;
  }

  getSafeThreadSuggestion(suggested) {
    if (typeof suggested !== "number" || isNaN(suggested)) return 1;
    return Math.max(1, Math.min(this.maxThreads, Math.round(suggested)));
  }

  logThreadDecision(suggested, clamped) {
    if (suggested !== clamped) {
      console.warn(
        `[ScalingDecisionEngine] Clamped thread suggestion from ${suggested} to ${clamped}`
      );
    }
  }
}

export default ScalingDecisionEngine;
