import scalingDatabase from "./scalingDatabase.js";

class UsageHistoryManager {
  constructor({ maxHistoryAgeMinutes = 5, maxDataPoints = 300 } = {}) {
    this.maxHistoryAge = maxHistoryAgeMinutes * 60 * 1000;
    this.maxDataPoints = maxDataPoints;
  }

  addUsageData(usageData) {
    if (scalingDatabase.available) {
      scalingDatabase.addUsageData({
        timestamp: Date.now(),
        ...usageData,
      });
    } else {
      // In-memory fallback (lightweight ring buffer)
      if (!this._memoryHistory) {
        this._memoryHistory = [];
      }
      this._memoryHistory.push({ timestamp: Date.now(), ...usageData });
      this._memoryHistory = this._memoryHistory.slice(-this.maxDataPoints);
    }
    this.cleanup();
    return true;
  }

  cleanup() {
    if (scalingDatabase.available) {
      scalingDatabase.cleanupOldUsageData(this.maxHistoryAge / 60000);
    } else if (this._memoryHistory) {
      const cutoff = Date.now() - this.maxHistoryAge;
      this._memoryHistory = this._memoryHistory.filter(
        (point) => point.timestamp >= cutoff
      );
      if (this._memoryHistory.length > this.maxDataPoints) {
        this._memoryHistory = this._memoryHistory.slice(-this.maxDataPoints);
      }
    }
  }

  getRecentUsage(seconds = 60) {
    if (scalingDatabase.available) {
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      return scalingDatabase.getUsageHistory(minutes);
    }
    this.cleanup();
    const cutoff = Date.now() - seconds * 1000;
    return (this._memoryHistory || []).filter(
      (point) => point.timestamp >= cutoff
    );
  }

  getAllHistory() {
    this.cleanup();
    if (scalingDatabase.available) {
      return scalingDatabase.getUsageHistory(this.maxHistoryAge / 60000);
    }
    return [...(this._memoryHistory || [])];
  }

  calculateTrend(values) {
    if (values.length < 2) return 0;
    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * values[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    const denom = n * sumXX - sumX * sumX;
    return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  }

  calculateRateOfChange(values) {
    if (values.length < 2) return 0;
    const recent = values.slice(-10);
    const changes = [];
    for (let i = 1; i < recent.length; i++) {
      changes.push(recent[i] - recent[i - 1]);
    }
    return changes.reduce((a, b) => a + b, 0) / changes.length;
  }

  predictThresholdReach(
    currentCpu,
    cpuTrend,
    tempTrend,
    cpuRateOfChange,
    tempRateOfChange,
    currentTemp
  ) {
    const thresholds = {
      cpu: 85,
      temp: 80,
      emergency: { cpu: 95, temp: 90 },
    };
    const predictions = {};
    if (cpuRateOfChange > 0 && currentCpu < thresholds.cpu) {
      predictions.cpuThreshold = Math.max(
        0,
        (thresholds.cpu - currentCpu) / cpuRateOfChange
      );
    }
    if (cpuRateOfChange > 0 && currentCpu < thresholds.emergency.cpu) {
      predictions.cpuEmergency = Math.max(
        0,
        (thresholds.emergency.cpu - currentCpu) / cpuRateOfChange
      );
    }
    if (tempRateOfChange > 0) {
      if (currentTemp < thresholds.temp) {
        predictions.tempThreshold = Math.max(
          0,
          (thresholds.temp - currentTemp) / tempRateOfChange
        );
      }
      if (currentTemp < thresholds.emergency.temp) {
        predictions.tempEmergency = Math.max(
          0,
          (thresholds.emergency.temp - currentTemp) / tempRateOfChange
        );
      }
    }
    return predictions;
  }

  analyzeOperationMixChanges(operationMixes) {
    if (operationMixes.length < 2) {
      return { hasChanges: false };
    }
    const recent = operationMixes.slice(-5);
    const changes = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      const newTypes = Object.keys(curr).filter((type) => !prev[type]);
      const removedTypes = Object.keys(prev).filter((type) => !curr[type]);
      if (newTypes.length > 0 || removedTypes.length > 0) {
        changes.push({
          timestamp: i,
          newTypes,
          removedTypes,
          intensityChange: this.calculateIntensityChange(prev, curr),
        });
      }
    }
    return {
      hasChanges: changes.length > 0,
      changes,
      currentMix: recent[recent.length - 1] || {},
    };
  }

  calculateIntensityChange(prevMix, currMix) {
    const prevTotal = Object.values(prevMix).reduce((sum, count) => sum + count, 0);
    const currTotal = Object.values(currMix).reduce((sum, count) => sum + count, 0);
    return currTotal - prevTotal;
  }

  async analyzeUsageTrends() {
    const history = this.getAllHistory();
    if (!history || history.length < 10) {
      return { hasEnoughData: false, reason: "insufficient_data" };
    }

    const cpuUsage = history.map((p) => p.cpu_usage || 0);
    const cpuTemp = history.map((p) => p.cpu_temp || 0);
    const memoryUsage = history.map((p) => p.memory_usage || 0);
    const threadCounts = history.map((p) => p.concurrent_threads || 1);
    const operationMixes = history.map((p) => {
      try {
        return JSON.parse(p.operation_mix || "{}");
      } catch {
        return {};
      }
    });

    const cpuTrend = this.calculateTrend(cpuUsage);
    const tempTrend = this.calculateTrend(cpuTemp);
    const memoryTrend = this.calculateTrend(memoryUsage);
    const threadTrend = this.calculateTrend(threadCounts);
    const cpuRateOfChange = this.calculateRateOfChange(cpuUsage);
    const tempRateOfChange = this.calculateRateOfChange(cpuTemp);
    const predictions = this.predictThresholdReach(
      cpuUsage[cpuUsage.length - 1],
      cpuTrend,
      tempTrend,
      cpuRateOfChange,
      tempRateOfChange,
      cpuTemp[cpuTemp.length - 1]
    );
    const operationMixAnalysis =
      this.analyzeOperationMixChanges(operationMixes);

    return {
      hasEnoughData: true,
      currentMetrics: {
        cpuUsage: cpuUsage[cpuUsage.length - 1],
        cpuTemp: cpuTemp[cpuTemp.length - 1],
        memoryUsage: memoryUsage[memoryUsage.length - 1],
        threadCount: threadCounts[threadCounts.length - 1],
      },
      trends: { cpu: cpuTrend, temp: tempTrend, memory: memoryTrend, threads: threadTrend },
      rateOfChange: { cpu: cpuRateOfChange, temp: tempRateOfChange },
      predictions,
      operationMixAnalysis,
      dataPoints: history.length,
      timeSpan:
        (history[history.length - 1].timestamp - history[0].timestamp) / 1000,
    };
  }

  getStatistics() {
    const history = this.getAllHistory();
    if (!history || history.length === 0) {
      return { dataPoints: 0, timeSpan: 0 };
    }
    const cpuUsage = history.map((p) => p.cpu_usage || 0);
    const cpuTemp = history.map((p) => p.cpu_temp || 0);
    const threadCounts = history.map((p) => p.concurrent_threads || 1);
    return {
      dataPoints: history.length,
      timeSpan:
        (history[history.length - 1].timestamp - history[0].timestamp) / 1000,
      averages: {
        cpuUsage: cpuUsage.reduce((a, b) => a + b, 0) / cpuUsage.length,
        cpuTemp: cpuTemp.reduce((a, b) => a + b, 0) / cpuTemp.length,
        threadCount:
          threadCounts.reduce((a, b) => a + b, 0) / threadCounts.length,
      },
      ranges: {
        cpuUsage: { min: Math.min(...cpuUsage), max: Math.max(...cpuUsage) },
        cpuTemp: { min: Math.min(...cpuTemp), max: Math.max(...cpuTemp) },
        threadCount: {
          min: Math.min(...threadCounts),
          max: Math.max(...threadCounts),
        },
      },
    };
  }

  async getScalingRecommendations(thresholds = {}) {
    const analysis = await this.analyzeUsageTrends();
    if (!analysis.hasEnoughData) {
      return { action: "maintain", reason: "insufficient_data", confidence: 0.3 };
    }
    const { currentMetrics, predictions } = analysis;
    const highCpuThreshold = thresholds.highCpuUsage || 85;
    const highTempThreshold = thresholds.highTemp || 80;
    if (
      currentMetrics.cpuUsage > highCpuThreshold ||
      currentMetrics.cpuTemp > highTempThreshold
    ) {
      return {
        action: "scale_down",
        reason: "high_current_usage",
        urgency: "high",
        confidence: 0.9,
        metrics: currentMetrics,
      };
    }
    if (predictions.cpuThreshold && predictions.cpuThreshold < 30) {
      return {
        action: "scale_down",
        reason: "predicted_threshold_reach",
        urgency: "medium",
        confidence: 0.7,
        timeToThreshold: predictions.cpuThreshold,
        metrics: currentMetrics,
      };
    }
    if (
      currentMetrics.cpuUsage < 50 &&
      currentMetrics.cpuTemp < 70 &&
      analysis.trends.cpu < 0
    ) {
      return {
        action: "scale_up",
        reason: "low_usage_stable_trend",
        urgency: "low",
        confidence: 0.6,
        metrics: currentMetrics,
      };
    }
    return {
      action: "maintain",
      reason: "stable_conditions",
      confidence: 0.5,
      metrics: currentMetrics,
    };
  }
}

const usageHistoryManager = new UsageHistoryManager();
export default usageHistoryManager;
export { UsageHistoryManager };
