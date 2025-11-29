import { ThreadManager } from "./ThreadManager.js";
import { SystemMonitor } from "./SystemMonitor.js";

export class LLMThreader {
  constructor(options = {}) {
    const normalizedMaxThreads =
      Number.isFinite(options.maxThreads) && options.maxThreads > 0
        ? options.maxThreads
        : null;

    this.options = {
      monitoringInterval: options.monitoringInterval || 1000,
      maxHistoryAgeMinutes: options.maxHistoryAgeMinutes || 5,
      maxDataPoints: options.maxDataPoints || 300,
      emergencyAbsoluteLimits: options.emergencyAbsoluteLimits || {
        cpuTemp: 95,
        cpuUsage: 98,
        memoryUsage: 95,
        gpuTemp: 95,
        gpuUsage: 98,
      },
      highThresholds: options.highThresholds || {
        cpuUsage: 85,
        cpuTemp: 85,
        memoryUsage: 85,
        gpuTemp: 85,
        gpuUsage: 85,
      },
      ...options,
      maxThreads: normalizedMaxThreads,
    };

    this.threadManager = new ThreadManager({
      maxHistorySize: options.maxHistorySize || 100,
      onScalingUpdate: (newLimit, oldLimit) => {
        if (this.options.onScalingUpdate) {
          this.options.onScalingUpdate(newLimit, oldLimit);
        }
      },
    });

    this.systemMonitor = new SystemMonitor({
      maxThreads: this.options.maxThreads,
      intervalMs: this.options.monitoringInterval,
      emergencyAbsoluteLimits: this.options.emergencyAbsoluteLimits,
      highThresholds: this.options.highThresholds,
      maxHistoryAgeMinutes: this.options.maxHistoryAgeMinutes,
      maxDataPoints: this.options.maxDataPoints,
      scalingHistoryRetentionHours: this.options.scalingHistoryRetentionHours,
      onScalingUpdate: (newThreads, oldThreads) => {
        this.threadManager.updateThreadLimits(newThreads);
        if (this.options.onScalingUpdate) {
          this.options.onScalingUpdate(newThreads, oldThreads);
        }
      },
      getQueueMetrics: () => {
        const state = this.threadManager.getState();
        const stats = this.threadManager.getQueueStats();
        const backlog = stats.backlog;
        return {
          queuePressure: state.queueSize,
          activeThreads: state.activeRequests,
           backlog,
          operationMix: {},
          operationMixWithContext: null,
          throughput: stats.throughput,
          avgLatency: stats.avgLatency,
          p95Latency: stats.p95Latency,
        };
      },
    });

    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    this.systemMonitor.startContinuousMonitoring();
    this.isInitialized = true;
  }

  async execute(operation, options = {}) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return await this.threadManager.execute(operation, options);
  }

  getState() {
    return {
      threadManager: this.threadManager.getState(),
      scaling: this.systemMonitor.getScalingState(),
      queueStats: this.threadManager.getQueueStats(),
    };
  }

  getUsageHistory() {
    return this.systemMonitor.scalingEngine.usageHistoryManager.getAllHistory();
  }

  getUsageStatistics() {
    return this.systemMonitor.scalingEngine.usageHistoryManager.getStatistics();
  }

  getUsageTrends() {
    return this.systemMonitor.scalingEngine.usageHistoryManager.analyzeUsageTrends();
  }

  shutdown() {
    this.systemMonitor.stopContinuousMonitoring();
    this.isInitialized = false;
  }
}

export { ThreadManager } from "./ThreadManager.js";
export { ScalingDecisionEngine } from "./ScalingDecisionEngine.js";
export { SystemMonitor } from "./SystemMonitor.js";

export default LLMThreader;
