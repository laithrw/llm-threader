class LLMRequest {
  constructor(id, operation, priority = 0, emergencyBypass = false) {
    this.id = id;
    this.operation = operation;
    this.priority = priority;
    this.emergencyBypass = emergencyBypass;
    this.startTime = Date.now();
    this.endTime = null;
    this.status = "queued";
    this.result = null;
    this.error = null;
  }

  start() {
    this.status = "active";
    this.startTime = Date.now();
  }

  complete(result) {
    this.status = "completed";
    this.endTime = Date.now();
    this.result = result;
  }

  fail(error) {
    this.status = "failed";
    this.endTime = Date.now();
    this.error = error;
  }

  getDuration() {
    const endTime = this.endTime || Date.now();
    return endTime - this.startTime;
  }
}

export class ThreadManager {
  constructor(options = {}) {
    this.maxConcurrentRequests = 1;
    this.activeRequests = 0;
    this.requestQueue = [];
    this.isProcessing = false;
    this.lastUpdate = Date.now();
    this.requestHistory = [];
    this.maxHistorySize = options.maxHistorySize || 100;
    this.emergencyBypassActive = false;
    this.onScalingUpdate = options.onScalingUpdate || null;
    this.desiredThreadCount = null; // Track desired count when scaling down is blocked
  }

  updateThreadLimits(recommendedThreadCount) {
    let newLimit = recommendedThreadCount;

    if (typeof newLimit !== "number" || isNaN(newLimit) || newLimit < 1) {
      console.warn(
        `[Thread Manager] Invalid thread count: ${newLimit}, defaulting to 1`
      );
      newLimit = 1;
    }

    if (this.emergencyBypassActive) {
      const emergencyRequestsInQueue = this.requestQueue.filter(
        (req) => req.emergencyBypass
      ).length;
      const emergencyRequestsActive = this.requestHistory.filter(
        (req) => req.status === "active" && req.emergencyBypass
      ).length;

      if (emergencyRequestsInQueue > 0 || emergencyRequestsActive > 0) {
        newLimit = Math.max(
          newLimit,
          Math.min(2, emergencyRequestsInQueue + emergencyRequestsActive)
        );
      } else {
        newLimit = Math.max(newLimit, 1);
      }
    }

    // Never scale down below the number of currently active requests
    // Only scale down when threads are vacant (idle)
    if (newLimit < this.maxConcurrentRequests) {
      if (newLimit < this.activeRequests) {
        this.desiredThreadCount = newLimit;
        newLimit = this.activeRequests;
      } else {
        // Can scale down now - clear any pending desired count
        this.desiredThreadCount = null;
      }
    } else {
      // Scaling up or no change - clear any pending desired count
      this.desiredThreadCount = null;
    }

    if (newLimit !== this.maxConcurrentRequests) {
      const oldLimit = this.maxConcurrentRequests;
      this.maxConcurrentRequests = newLimit;

      if (this.onScalingUpdate) {
        this.onScalingUpdate(newLimit, oldLimit);
      }

      if (newLimit > oldLimit) {
        this.processQueue();
      }
    }

    this.lastUpdate = Date.now();
  }

  queueRequest(operation, priority = 0, emergencyBypass = false) {
    const requestId = `req_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    const request = new LLMRequest(
      requestId,
      operation,
      priority,
      emergencyBypass
    );

    if (emergencyBypass) {
      this.emergencyBypassActive = true;
    }

    this.requestQueue.push(request);

    this.requestQueue.sort((a, b) => {
      if (a.emergencyBypass && !b.emergencyBypass) return -1;
      if (!a.emergencyBypass && b.emergencyBypass) return 1;
      return b.priority - a.priority;
    });

    this.processQueue();

    return request;
  }

  processQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const emergencyRequestsInQueue = this.requestQueue.filter(
        (req) => req.emergencyBypass
      ).length;
      const hasEmergencyRequests = emergencyRequestsInQueue > 0;

      while (
        this.activeRequests < this.maxConcurrentRequests &&
        this.requestQueue.length > 0
      ) {
        const request = this.requestQueue.shift();
        if (request) {
          this.startRequest(request);
        }
      }

      if (
        hasEmergencyRequests &&
        this.activeRequests >= this.maxConcurrentRequests
      ) {
        const emergencyRequest = this.requestQueue.find(
          (req) => req.emergencyBypass
        );
        if (emergencyRequest) {
          const originalLimit = this.maxConcurrentRequests;
          this.maxConcurrentRequests = Math.min(originalLimit + 1, 2);

          const index = this.requestQueue.indexOf(emergencyRequest);
          if (index > -1) {
            this.requestQueue.splice(index, 1);
            this.startRequest(emergencyRequest);
          }

          this.maxConcurrentRequests = originalLimit;
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  startRequest(request) {
    this.activeRequests++;
    request.start();

    this.requestHistory.push(request);
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }

    Promise.resolve(request.operation())
      .then((result) => {
        this.completeRequest(request.id, result);
      })
      .catch((error) => {
        this.failRequest(request.id, error);
      });
  }

  completeRequest(requestId, result) {
    const request = this.findRequest(requestId);
    if (request) {
      request.complete(result);
      this.activeRequests = Math.max(0, this.activeRequests - 1);

      if (request.emergencyBypass) {
        const hasOtherEmergencyRequests = this.requestHistory.some(
          (req) =>
            req.status === "active" &&
            req.emergencyBypass &&
            req.id !== requestId
        );
        if (!hasOtherEmergencyRequests) {
          this.emergencyBypassActive = false;
        }
      }

      // Check if we can now scale down to desired count after this thread became vacant
      if (
        this.desiredThreadCount !== null &&
        this.activeRequests <= this.desiredThreadCount
      ) {
        const oldLimit = this.maxConcurrentRequests;
        this.maxConcurrentRequests = this.desiredThreadCount;
        if (this.onScalingUpdate) {
          this.onScalingUpdate(this.desiredThreadCount, oldLimit);
        }
        this.desiredThreadCount = null;
      }

      this.processQueue();
    }
  }

  failRequest(requestId, error) {
    const request = this.findRequest(requestId);
    if (request) {
      request.fail(error);
      this.activeRequests = Math.max(0, this.activeRequests - 1);

      if (request.emergencyBypass) {
        const hasOtherEmergencyRequests = this.requestHistory.some(
          (req) =>
            req.status === "active" &&
            req.emergencyBypass &&
            req.id !== requestId
        );
        if (!hasOtherEmergencyRequests) {
          this.emergencyBypassActive = false;
        }
      }

      // Check if can scale down to desired count after this thread became vacant
      if (
        this.desiredThreadCount !== null &&
        this.activeRequests <= this.desiredThreadCount
      ) {
        const oldLimit = this.maxConcurrentRequests;
        this.maxConcurrentRequests = this.desiredThreadCount;
        if (this.onScalingUpdate) {
          this.onScalingUpdate(this.desiredThreadCount, oldLimit);
        }
        this.desiredThreadCount = null;
      }

      this.processQueue();
    }
  }

  findRequest(requestId) {
    return this.requestHistory.find(
      (req) => req.id === requestId && req.status === "active"
    );
  }

  async execute(operation, options = {}) {
    const { priority = 0, emergencyBypass = false } = options;
    const request = this.queueRequest(operation, priority, emergencyBypass);

    while (request.status === "queued") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    if (request.status !== "active") {
      throw new Error(`Request ${request.id} was not started properly`);
    }

    while (request.status === "active") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    if (request.status === "completed") {
      return request.result;
    } else if (request.status === "failed") {
      throw request.error || new Error("Request failed");
    } else {
      throw new Error(`Unexpected request status: ${request.status}`);
    }
  }

  getState() {
    return {
      maxConcurrentRequests: this.maxConcurrentRequests,
      activeRequests: this.activeRequests,
      queueSize: this.requestQueue.length,
      isProcessing: this.isProcessing,
      lastUpdate: this.lastUpdate,
      historySize: this.requestHistory.length,
    };
  }

  getQueueStats() {
    const activeRequests = this.requestHistory.filter(
      (req) => req.status === "active"
    );
    const completedRequests = this.requestHistory.filter(
      (req) => req.status === "completed"
    );
    const failedRequests = this.requestHistory.filter(
      (req) => req.status === "failed"
    );

    const avgDuration =
      completedRequests.length > 0
        ? completedRequests.reduce((sum, req) => sum + req.getDuration(), 0) /
          completedRequests.length
        : 0;

    const recentCompleted = completedRequests
      .filter((req) => req.endTime && Date.now() - req.endTime < 60000)
      .slice(-20);

    const throughput =
      recentCompleted.length > 0 ? recentCompleted.length / 60 : 0;

    return {
      active: activeRequests.length,
      completed: completedRequests.length,
      failed: failedRequests.length,
      queued: this.requestQueue.length,
      avgDuration: avgDuration,
      maxConcurrent: this.maxConcurrentRequests,
      throughput,
      avgLatency: avgDuration,
    };
  }
}
