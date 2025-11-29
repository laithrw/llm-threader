export class RewardCalculator {
  constructor(highThresholds, emergencyAbsoluteLimits) {
    this.highThresholds = highThresholds;
    this.emergencyAbsoluteLimits = emergencyAbsoluteLimits;
  }

  computeReward({
    throughput,
    latencyMs,
    backlog,
    predictedCpu,
    predictedTemp,
    predictedGpuUsage,
    predictedGpuTemp,
  }) {
    const latencySec = Math.max(latencyMs || 0, 1) / 1000;
    const wThroughput = 1.0;
    const wLatency = 0.2;
    const wBacklog = 0.1;

    let reward = wThroughput * (throughput || 0);
    reward -= wLatency * latencySec;
    reward -= wBacklog * Math.max(backlog || 0, 0);

    const penal = (value, high, emergency, weight = 1) => {
      if (!Number.isFinite(value)) return 0;
      if (value >= emergency) return -1e6;
      if (value <= high) return 0;
      const over = value - high;
      return -weight * over * over;
    };

    reward += penal(
      predictedCpu,
      this.highThresholds.cpuUsage,
      this.emergencyAbsoluteLimits.cpuUsage,
      0.5
    );
    reward += penal(
      predictedTemp,
      this.highThresholds.cpuTemp,
      this.emergencyAbsoluteLimits.cpuTemp,
      0.7
    );
    reward += penal(
      predictedGpuUsage,
      this.highThresholds.gpuUsage,
      this.emergencyAbsoluteLimits.gpuUsage,
      0.3
    );
    reward += penal(
      predictedGpuTemp,
      this.highThresholds.gpuTemp,
      this.emergencyAbsoluteLimits.gpuTemp,
      0.5
    );

    return reward;
  }
}
