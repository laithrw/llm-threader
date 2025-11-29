export class PIDController {
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
