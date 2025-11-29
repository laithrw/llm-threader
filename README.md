# llm-threader

Efficiently run many local LLM calls on limited hardware without overheating or freezing your machine. `llm-threader` manages a thread pool where each thread is an LLM call, continuously monitors your system, and automatically adjusts concurrency to keep long-running and bursty workloads safe and fast.

It intelligently scales the number of concurrent LLM calls up and down to prevent overheating and maximize throughput.

## Example use cases

- **Consumer desktop apps with a local LLM**: e.g. a note-taking or coding assistant app that runs a local model for autocomplete, search, and summarization at the same time. You might fire off many LLM calls in parallel (multiple tabs, background indexing, long-running summaries), but you do **not** want the fan to spin up aggressively, the laptop to get hot, or the UI to freeze.
- **Long-running or batch workloads**: e.g. processing a large document set or running many evaluations where you care about total completion time and need to respect thermal and memory limits on a single machine.

## Features

- **Automatic Thread Scaling**: Dynamically adjusts concurrent request limits based on CPU/GPU usage and temperature
- **Resource-Aware**: Monitors system metrics in real-time to prevent freezing, crashing, or otherwise overextending your hardware
- **Priority Queue**: Supports priority-based request scheduling with emergency bypass
- **Statistical Analysis**: Uses PID controllers, Bayesian optimization, and predictive scaling
- **Cumulative-Time Optimization**: Automatically finds the thread count that minimizes total completion time when no manual cap is provided
- **Zero Configuration**: Works out of the box with sensible defaults

On powerful hardware with many cores, running too few LLM calls at once wastes capacity, while running too many makes each call slower. `llm-threader` continuously measures throughput and latency at different concurrency levels and locks onto the thread count where **adding more threads would start to increase total completion time instead of reducing it**. On very limited machines (e.g. a MacBook Air), that sweet spot is often just 1–2 concurrent calls, so you should not expect large speedups—but it will still keep your system responsive and protect against freezes and crashes.

## Installation

```bash
npm install llm-threader
```

## Quick Start

```javascript
import LLMThreader from "llm-threader";

const threader = new LLMThreader({
  // maxThreads: 12, // optional: omit to let llm-threader discover the optimal cap
  onScalingUpdate: (newThreads, oldThreads) => {
    console.log(`Threads scaled: ${oldThreads} -> ${newThreads}`);
  },
});

await threader.initialize();

// Execute LLM operations - they'll be automatically queued and scaled
const result = await threader.execute(async () => {
  // Your LLM call here
  return await yourLLM.generate(prompt);
});

// Get current state
const state = threader.getState();
console.log("Active threads:", state.threadManager.activeRequests);
console.log("Queue size:", state.threadManager.queueSize);
console.log("Recommended threads:", state.scaling.recommendedThreadCount);

// Cleanup
threader.shutdown();
```

## API

### `new LLMThreader(options)`

Creates a new LLMThreader instance.

**Options:**

- At a high level, you control:

  - **Concurrency**: how many LLM calls can run at once (`maxThreads`)
  - **Sampling**: how often hardware metrics are checked (`monitoringInterval`)
  - **History**: how much recent behavior is kept for analysis (`maxHistory*`, `maxDataPoints`)
  - **Safety limits**: when the system must back off to protect your machine from freezing or overheating (`emergencyAbsoluteLimits`, `highThresholds`)

- `maxThreads` (number | null, default: null): Hard ceiling for concurrent threads. When omitted, llm-threader keeps scaling up until cumulative completion time starts to degrade, and then locks onto that optimal value.
- `monitoringInterval` (number, default: 1000): How often, in milliseconds, the library samples CPU/GPU load, temperature, and memory (lower = reacts faster, higher = less overhead).
- `onScalingUpdate` (function): Called whenever the recommended concurrent LLM call limit changes: `(newThreads, oldThreads) => void`.
- `maxHistorySize` (number, default: 100): How many recent LLM requests are kept in the in-memory queue history used for throughput and latency stats.
- `maxHistoryAgeMinutes` (number, default: 5): How many minutes of past system/load data are kept for trend analysis.
- `maxDataPoints` (number, default: 300): Maximum number of sampled data points stored in the internal usage history window.
- `emergencyAbsoluteLimits` (object): **Hard safety cutoffs**; if any of these are reached or exceeded, the engine immediately scales down concurrent LLM calls to protect your machine:
  - `cpuTemp` (number, default: 95): Maximum allowed CPU temperature in °C.
  - `cpuUsage` (number, default: 98): Maximum allowed average CPU usage percentage.
  - `memoryUsage` (number, default: 95): Maximum allowed memory usage percentage.
  - `gpuTemp` (number, default: 95): Maximum allowed GPU temperature in °C.
  - `gpuUsage` (number, default: 98): Maximum allowed GPU utilization percentage.
- `highThresholds` (object): **Soft warning levels**; when metrics are above these, the engine starts nudging concurrency down, and when comfortably below them it is allowed to scale up:
  - `cpuUsage` (number, default: 85): High-but-safe CPU usage percentage.
  - `cpuTemp` (number, default: 85): High-but-safe CPU temperature in °C.
  - `memoryUsage` (number, default: 85): High-but-safe memory usage percentage.
  - `gpuTemp` (number, default: 85): High-but-safe GPU temperature in °C.
  - `gpuUsage` (number, default: 85): High-but-safe GPU utilization percentage.

### `threader.initialize()`

Starts the system monitoring and scaling engine. Called automatically on first `execute()` call.

### `threader.execute(operation, options)`

Executes an LLM operation through the thread pool.

**Parameters:**

- `operation` (function): Async function that performs the LLM operation
- `options` (object, optional):
  - `priority` (number, default: 0): Request priority (higher = more important)
  - `emergencyBypass` (boolean, default: false): Bypass normal queue limits

**Returns:** Promise that resolves with the operation result

### `threader.getState()`

Returns current state information:

- `threadManager`: Thread manager state (active requests, queue size, etc.)
- `scaling`: Scaling engine state (recommended threads, last decision, etc.)
- `queueStats`: Queue statistics (completed, failed, average duration, etc.)

### `threader.getUsageHistory()`

Returns the full usage history (last X minutes as configured by `maxHistoryAgeMinutes`).

### `threader.getUsageStatistics()`

Returns statistics about the usage history:

- `dataPoints`: Number of data points
- `timeSpan`: Time span in seconds
- `averages`: Average CPU usage, temperature, thread count
- `ranges`: Min/max values for each metric

### `threader.getUsageTrends()`

Returns trend analysis of usage history:

- `hasEnoughData`: Whether there's enough data for analysis
- `currentMetrics`: Current CPU usage, temperature, memory, thread count
- `trends`: Trend slopes for CPU, temperature, memory, threads
- `rateOfChange`: Rate of change per second for CPU and temperature
- `dataPoints`: Number of data points analyzed
- `timeSpan`: Time span of the analysis

### `threader.shutdown()`

Stops monitoring and cleans up resources.

## Advanced Usage

### Configuring Temperature and Thresholds

You can customize all temperature and usage thresholds:

```javascript
const threader = new LLMThreader({
  maxThreads: 12,
  maxHistoryAgeMinutes: 10, // Keep 10 minutes of history
  maxDataPoints: 600, // Store up to 600 data points

  // Emergency thresholds (trigger immediate scale-down)
  emergencyAbsoluteLimits: {
    cpuTemp: 90, // Lower emergency temp threshold
    cpuUsage: 95,
    memoryUsage: 90,
    gpuTemp: 90,
    gpuUsage: 95,
  },

  // High thresholds (trigger scaling adjustments)
  highThresholds: {
    cpuUsage: 80, // Lower high CPU threshold
    cpuTemp: 80, // Lower high temp threshold
    memoryUsage: 80,
    gpuTemp: 80,
    gpuUsage: 80,
  },
});
```

### Accessing Usage History

```javascript
// Get full history (last X minutes)
const history = threader.getUsageHistory();
console.log(`History contains ${history.length} data points`);

// Get statistics
const stats = threader.getUsageStatistics();
console.log(`Average CPU: ${stats.averages.cpuUsage.toFixed(1)}%`);
console.log(`Average Temp: ${stats.averages.cpuTemp.toFixed(1)}°C`);
console.log(`Time span: ${stats.timeSpan.toFixed(0)}s`);

// Get trend analysis
const trends = threader.getUsageTrends();
if (trends.hasEnoughData) {
  console.log(
    `CPU trend: ${trends.trends.cpu > 0 ? "increasing" : "decreasing"}`
  );
  console.log(
    `Temp rate of change: ${trends.rateOfChange.temp.toFixed(2)}°C/s`
  );
}
```

### Priority Levels

```javascript
// High priority request
await threader.execute(operation, { priority: 10 });

// Normal priority (default)
await threader.execute(operation, { priority: 5 });

// Low priority
await threader.execute(operation, { priority: 1 });
```

### Emergency Bypass

For critical operations that need immediate processing:

```javascript
await threader.execute(operation, {
  priority: 10,
  emergencyBypass: true,
});
```

### Custom Scaling Configuration

```javascript
import { SystemMonitor, ScalingDecisionEngine } from "llm-threader";

const monitor = new SystemMonitor({
  maxThreads: 16,
  kp: 0.5, // PID proportional gain
  ki: 0.05, // PID integral gain
  kd: 0.1, // PID derivative gain
  setpoint: 90, // Target CPU usage percentage
  emergencyAbsoluteLimits: {
    cpuTemp: 95,
    cpuUsage: 98,
    memoryUsage: 95,
    gpuTemp: 95,
    gpuUsage: 98,
  },
});
```

## How It Works

1. **System Monitoring**: Samples CPU usage, CPU temperature, memory usage, GPU usage, and GPU temperature at a configurable interval.
2. **Performance Tracking**: Records per-interval metrics plus active thread count and request timings in a bounded history window.
3. **Predictive Analysis**: Fits simple trend models (e.g. linear regression) over the history to estimate where CPU, temperature, and memory will be in the near future at the current thread count.
4. **Dynamic Adjustment**: Combines PID control and Bayesian optimization to select the next thread count that hits a target utilization setpoint while respecting your configured limits.
5. **Queue Management**: Schedules operations through a priority queue, enforces the current thread limit, and supports emergency bypass for critical work.

## Scaling Algorithm

At each decision step, the scaling engine:

- **Checks emergency limits**: If any emergency absolute limit (CPU/GPU temp, usage, memory) is exceeded or about to be exceeded, it immediately scales down the maximum concurrent threads.
- **Evaluates high thresholds**: If metrics are above high thresholds but below emergency limits, it nudges the thread count down; if safely below, it considers scaling up.
- **Applies PID control**: Uses a PID controller on CPU usage (or configured setpoint metric) to compute a suggested adjustment in thread count.
- **Runs Bayesian optimization**: When no hard `maxThreads` is provided, it treats thread count as a decision variable and searches for the value that minimizes cumulative completion time over recent history.
- **Locks in the recommendation**: Chooses a new recommended thread count, applies it to the queue, and records the outcome for the next iteration.

## Requirements

- Node.js >= 18.0.0
- `systeminformation` package (for system metrics)
- `bayesian-optimizer` package (for optimization)

## License

MIT
