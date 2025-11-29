import si from "systeminformation";
import { ScalingDecisionEngine } from "./ScalingDecisionEngine.js";

function calculateAverage(numbers) {
  const validNumbers = numbers.filter((n) => n !== null && n !== undefined);
  if (validNumbers.length === 0) return null;
  return validNumbers.reduce((a, b) => a + b, 0) / validNumbers.length;
}

export class SystemMonitor {
  constructor(options = {}) {
    const highThresholds = {
      cpuUsage: options.highThresholds?.cpuUsage || 85,
      cpuTemp: options.highThresholds?.cpuTemp || 85,
      memoryUsage: options.highThresholds?.memoryUsage || 85,
      gpuTemp: options.highThresholds?.gpuTemp || 85,
      gpuUsage: options.highThresholds?.gpuUsage || 85,
    };

    const emergencyThresholds = {
      cpuTemp: options.emergencyAbsoluteLimits?.cpuTemp || 95,
      cpuUsage: options.emergencyAbsoluteLimits?.cpuUsage || 98,
      memoryUsage: options.emergencyAbsoluteLimits?.memoryUsage || 95,
      gpuTemp: options.emergencyAbsoluteLimits?.gpuTemp || 95,
      gpuUsage: options.emergencyAbsoluteLimits?.gpuUsage || 98,
    };

    this.highThresholds = highThresholds;
    this.emergencyThresholds = emergencyThresholds;

    this.scalingEngine = new ScalingDecisionEngine({
      maxThreads: options.maxThreads,
      kp: options.kp || 0.5,
      ki: options.ki || 0.05,
      kd: options.kd || 0.1,
      setpoint: options.setpoint || 90,
      emergencyAbsoluteLimits: emergencyThresholds,
      highThresholds: highThresholds,
      maxHistoryAgeMinutes: options.maxHistoryAgeMinutes || 5,
      maxDataPoints: options.maxDataPoints || 300,
    });
    this.options = options;

    this.monitoringInterval = null;
    this.isMonitoringActive = false;
    this.intervalMs = options.intervalMs || 1000;

    this.monitoringState = {
      currentThreadCount: 1,
      recommendedThreadCount: 1,
      lastScalingDecision: null,
      systemMetrics: [],
      maxMetricsHistory: 120,
    };

    this.onScalingUpdate = options.onScalingUpdate || null;
    this.getQueueMetrics = options.getQueueMetrics || null;
    this._tickInFlight = false;
  }

  async getEnhancedSystemInfo() {
    try {
      const loadData = await si.currentLoad();
      const cpuLoad = loadData?.currentLoad;

      const tempData = await si.cpuTemperature();
      const allTemps = [tempData.main, ...(tempData.cores || []), tempData.max];
      const avgTemp = calculateAverage(allTemps);

      const memData = await si.mem();
      const memoryUsage = memData ? (memData.used / memData.total) * 100 : null;

      let gpuTemp = null;
      let gpuUsage = null;
      try {
        const gpuData = await si.graphics();
        if (gpuData && gpuData.controllers && gpuData.controllers.length > 0) {
          const primaryGPU = gpuData.controllers[0];
          gpuTemp = primaryGPU.temperatureGpu;
          gpuUsage = primaryGPU.utilizationGpu;
        }
      } catch (gpuError) {
        // GPU info not available
      }

      return {
        cpuLoad,
        avgTemp,
        avgCpuUsage: cpuLoad,
        avgCpuTemp: avgTemp,
        memoryUsage,
        avgMemoryUsage: memoryUsage,
        gpuTemp,
        avgGpuTemp: gpuTemp,
        gpuUsage,
        avgGpuUsage: gpuUsage,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("Error getting system information:", error);
      return {
        cpuLoad: null,
        avgTemp: null,
        avgCpuUsage: null,
        avgCpuTemp: null,
        memoryUsage: null,
        avgMemoryUsage: null,
        gpuTemp: null,
        avgGpuTemp: null,
        gpuUsage: null,
        avgGpuUsage: null,
        timestamp: Date.now(),
      };
    }
  }

  updateMetricsHistory(systemInfo) {
    this.monitoringState.systemMetrics.push(systemInfo);

    if (
      this.monitoringState.systemMetrics.length >
      this.monitoringState.maxMetricsHistory
    ) {
      this.monitoringState.systemMetrics.shift();
    }
  }

  async monitorSystemWithScaling() {
    if (this._tickInFlight) {
      return null;
    }
    this._tickInFlight = true;

    try {
      const systemInfo = await this.getEnhancedSystemInfo();
      this.updateMetricsHistory(systemInfo);

      let queueMetrics = {
        queuePressure: 0,
        activeThreads: this.monitoringState.currentThreadCount,
        backlog: this.monitoringState.currentThreadCount,
        operationMix: {},
        operationMixWithContext: null,
        throughput: null,
        avgLatency: null,
      };

      if (this.getQueueMetrics) {
        const externalMetrics = await this.getQueueMetrics();
        if (externalMetrics && typeof externalMetrics === "object") {
          queueMetrics = {
            ...queueMetrics,
            ...externalMetrics,
          };
        }
      }

    const throughput =
      queueMetrics.throughput !== undefined ? queueMetrics.throughput : null;
    const avgLatency =
      queueMetrics.avgLatency !== undefined ? queueMetrics.avgLatency : null;
    const p95Latency =
      queueMetrics.p95Latency !== undefined ? queueMetrics.p95Latency : null;
    const backlogSize =
      queueMetrics.backlog !== undefined
        ? queueMetrics.backlog
        : queueMetrics.queuePressure + queueMetrics.activeThreads;

      this.scalingEngine.recordPerformanceData(
        this.monitoringState.systemMetrics,
        this.monitoringState.currentThreadCount,
        queueMetrics.queuePressure,
        queueMetrics.activeThreads,
        queueMetrics.operationMix,
        queueMetrics.operationMixWithContext,
      throughput,
      avgLatency,
      backlogSize,
      p95Latency
    );

    const scalingResult = await this.scalingEngine.findOptimalThreadCount(
      this.monitoringState.systemMetrics,
      [queueMetrics.operationMix],
      null,
      {
        cpu: this.emergencyThresholds.cpuUsage,
        temp: this.emergencyThresholds.cpuTemp,
        gpu: this.emergencyThresholds.gpuUsage,
      },
      systemInfo.avgTemp >= this.emergencyThresholds.cpuTemp ||
        systemInfo.cpuLoad >= this.emergencyThresholds.cpuUsage ||
        (systemInfo.avgGpuTemp || 0) >= this.emergencyThresholds.gpuTemp ||
        (systemInfo.avgGpuUsage || 0) >= this.emergencyThresholds.gpuUsage,
      systemInfo.avgTemp >= this.highThresholds.cpuTemp ||
        systemInfo.cpuLoad >= this.highThresholds.cpuUsage ||
        (systemInfo.avgGpuTemp || 0) >= this.highThresholds.gpuTemp ||
        (systemInfo.avgGpuUsage || 0) >= this.highThresholds.gpuUsage,
      queueMetrics.operationMixWithContext
    );

      if (
        !scalingResult ||
        typeof scalingResult.recommendedThreads !== "number" ||
        isNaN(scalingResult.recommendedThreads)
      ) {
        scalingResult.recommendedThreads = 1;
        scalingResult.reason = "fallback_safety";
        scalingResult.confidence = 0.5;
      }

      this.monitoringState.recommendedThreadCount =
        scalingResult.recommendedThreads;
      this.monitoringState.lastScalingDecision = {
        timestamp: Date.now(),
        recommendedThreads: scalingResult.recommendedThreads,
        reason: scalingResult.reason,
        confidence: scalingResult.confidence,
      };

      if (
        this.monitoringState.currentThreadCount !==
        scalingResult.recommendedThreads
      ) {
        const oldCount = this.monitoringState.currentThreadCount;
        this.monitoringState.currentThreadCount =
          scalingResult.recommendedThreads;

        if (this.onScalingUpdate) {
          this.onScalingUpdate(scalingResult.recommendedThreads, oldCount);
        }
      }

      return {
        ...systemInfo,
        currentThreadCount: this.monitoringState.currentThreadCount,
        recommendedThreadCount: this.monitoringState.recommendedThreadCount,
        scalingDecision: this.monitoringState.lastScalingDecision,
      };
    } finally {
      this._tickInFlight = false;
    }
  }

  startContinuousMonitoring() {
    if (this.isMonitoringActive) {
      return;
    }

    this.isMonitoringActive = true;

    this.monitoringInterval = setInterval(async () => {
      try {
        await this.monitorSystemWithScaling();
      } catch (error) {
        console.error("[System Monitor] Error in monitoring loop:", error);
      }
    }, this.intervalMs);
  }

  stopContinuousMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoringActive = false;
  }

  getScalingState() {
    return {
      currentThreadCount: this.monitoringState.currentThreadCount,
      recommendedThreadCount: this.monitoringState.recommendedThreadCount,
      lastScalingDecision: this.monitoringState.lastScalingDecision,
      systemMetrics: this.monitoringState.systemMetrics.length,
      isMonitoringActive: this.isMonitoringActive,
    };
  }
}
