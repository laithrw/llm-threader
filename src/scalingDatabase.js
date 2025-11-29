import Database from "better-sqlite3";
import path from "path";
import { getDataDirectory } from "./utils/dataPaths.js";

class ScalingDatabase {
  constructor() {
    const dbPath = path.join(getDataDirectory(), "scaling.db");
    try {
      this.db = new Database(dbPath);
      this.initialize();
      this.available = true;
      this.scalingRetentionHours = 1 / 3; // default ~20 minutes
    } catch (error) {
      console.warn(
        "[llm-threader] Failed to open persistent scaling DB, falling back to in-memory only.",
        error?.message || error
      );
      this.db = null;
      this.available = false;
    }
  }

  initialize() {
    if (!this.db) return;
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS usage_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER,
          cpu_usage REAL,
          cpu_temp REAL,
          memory_usage REAL,
          gpu_usage REAL,
          gpu_temp REAL,
          concurrent_threads INTEGER,
          active_threads INTEGER,
          queue_pressure INTEGER,
          operation_mix TEXT,
          operation_intensity REAL
        );`
      )
      .run();

    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS scaling_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER,
          thread_count INTEGER,
          cpu_usage REAL,
          gpu_usage REAL,
          memory_usage REAL,
          temperature REAL,
          active_operations INTEGER,
          queue_length INTEGER,
          scaling_decision TEXT,
          pid_output REAL,
          bayes_optimization REAL,
          demand_score REAL
        );`
      )
      .run();

    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS operation_profiles (
          operation_type TEXT PRIMARY KEY,
          cpu_avg REAL,
          gpu_avg REAL,
          memory_avg REAL,
          temperature_avg REAL,
          duration_avg REAL,
          count INTEGER,
          last_updated INTEGER
        );`
      )
      .run();
  }

  addUsageData(data) {
    if (!this.db) return null;
    const stmt = this.db.prepare(
      `INSERT INTO usage_history (
        timestamp, cpu_usage, cpu_temp, memory_usage, gpu_usage, gpu_temp,
        concurrent_threads, active_threads, queue_pressure, operation_mix, operation_intensity
      ) VALUES (@timestamp, @cpu_usage, @cpu_temp, @memory_usage, @gpu_usage, @gpu_temp,
        @concurrent_threads, @active_threads, @queue_pressure, @operation_mix, @operation_intensity);`
    );
    stmt.run({
      timestamp: data.timestamp,
      cpu_usage: data.cpuUsage,
      cpu_temp: data.cpuTemp,
      memory_usage: data.memoryUsage,
      gpu_usage: data.gpuUsage,
      gpu_temp: data.gpuTemp,
      concurrent_threads: data.concurrentThreads,
      active_threads: data.activeThreads,
      queue_pressure: data.queuePressure,
      operation_mix: JSON.stringify(data.operationMix || {}),
      operation_intensity: data.operationIntensity || 0,
    });
  }

  getUsageHistory(minutes = 5) {
    if (!this.db) return [];
    const cutoff = Date.now() - minutes * 60 * 1000;
    const stmt = this.db.prepare(
      `SELECT * FROM usage_history WHERE timestamp >= ? ORDER BY timestamp ASC;`
    );
    return stmt.all(cutoff);
  }

  cleanupOldUsageData(minutes = 5) {
    if (!this.db) return { deleted: 0 };
    const cutoff = Date.now() - minutes * 60 * 1000;
    const stmt = this.db.prepare(
      `DELETE FROM usage_history WHERE timestamp < ?;`
    );
    const info = stmt.run(cutoff);
    return { deleted: info.changes || 0 };
  }

  addScalingHistory(entry) {
    if (!this.db) return null;
    const stmt = this.db.prepare(
      `INSERT INTO scaling_history (
        timestamp, thread_count, cpu_usage, gpu_usage, memory_usage, temperature,
        active_operations, queue_length, scaling_decision, pid_output, bayes_optimization, demand_score
      ) VALUES (@timestamp, @thread_count, @cpu_usage, @gpu_usage, @memory_usage, @temperature,
        @active_operations, @queue_length, @scaling_decision, @pid_output, @bayes_optimization, @demand_score);`
    );
    stmt.run({
      timestamp: entry.timestamp,
      thread_count: entry.threadCount,
      cpu_usage: entry.cpuUsage,
      gpu_usage: entry.gpuUsage,
      memory_usage: entry.memoryUsage,
      temperature: entry.temperature,
      active_operations: entry.activeOperations,
      queue_length: entry.queueLength,
      scaling_decision: entry.scalingDecision,
      pid_output: entry.pidOutput,
      bayes_optimization: entry.bayesOptimization,
      demand_score: entry.demandScore,
    });

    // Keep scaling history bounded (default: ~20 minutes)
    this.cleanupOldScalingHistory(this.scalingRetentionHours);
  }

  getScalingHistory(hours = 24) {
    if (!this.db) return [];
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      `SELECT * FROM scaling_history WHERE timestamp >= ? ORDER BY timestamp ASC;`
    );
    return stmt.all(cutoff);
  }

  cleanupOldScalingHistory(hours = this.scalingRetentionHours || 1 / 3) {
    if (!this.db) return { deleted: 0 };
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      `DELETE FROM scaling_history WHERE timestamp < ?;`
    );
    const info = stmt.run(cutoff);
    return { deleted: info.changes || 0 };
  }

  setScalingRetentionHours(hours) {
    if (Number.isFinite(hours) && hours > 0) {
      this.scalingRetentionHours = hours;
    }
  }

  updateOperationProfile(operationType, profile) {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT INTO operation_profiles (
        operation_type, cpu_avg, gpu_avg, memory_avg, temperature_avg, duration_avg, count, last_updated
      ) VALUES (@operation_type, @cpu_avg, @gpu_avg, @memory_avg, @temperature_avg, @duration_avg, @count, @last_updated)
      ON CONFLICT(operation_type) DO UPDATE SET
        cpu_avg=excluded.cpu_avg,
        gpu_avg=excluded.gpu_avg,
        memory_avg=excluded.memory_avg,
        temperature_avg=excluded.temperature_avg,
        duration_avg=excluded.duration_avg,
        count=excluded.count,
        last_updated=excluded.last_updated;`
    );
    stmt.run({
      operation_type: operationType,
      cpu_avg: profile.cpu_avg || 0,
      gpu_avg: profile.gpu_avg || 0,
      memory_avg: profile.memory_avg || 0,
      temperature_avg: profile.temperature_avg || 0,
      duration_avg: profile.duration_avg || 0,
      count: profile.count || 0,
      last_updated: profile.last_updated || Date.now(),
    });
  }

  getAllOperationProfiles() {
    if (!this.db) return [];
    const stmt = this.db.prepare(`SELECT * FROM operation_profiles;`);
    return stmt.all();
  }
}

const scalingDatabase = new ScalingDatabase();
export { scalingDatabase };
export default scalingDatabase;
