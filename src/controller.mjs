export class JobController {
  constructor({ onEvent = () => {} } = {}) {
    this.lifecycle = 'running';
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.waiter = null;
    this.listeners = new Set([onEvent]);
    this.sequence = 0;
  }

  getState() { return this.lifecycle; }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, details = {}) {
    const event = { id: ++this.sequence, timestamp: new Date().toISOString(), type, lifecycle: this.lifecycle, ...details };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  pause() {
    if (['complete', 'incomplete', 'cancelled'].includes(this.lifecycle)) return false;
    this.pauseRequested = true;
    this.emit('pause-requested');
    return true;
  }

  resume() {
    if (!this.pauseRequested && this.lifecycle !== 'paused' && this.lifecycle !== 'waiting-for-user-action') return false;
    this.pauseRequested = false;
    this.lifecycle = 'running';
    this.emit('resume-requested');
    this.waiter?.();
    this.waiter = null;
    return true;
  }

  cancel() {
    if (['complete', 'incomplete', 'cancelled'].includes(this.lifecycle)) return false;
    this.cancelRequested = true;
    this.lifecycle = 'cancelling';
    this.emit('cancellation-requested');
    this.waiter?.();
    this.waiter = null;
    return true;
  }

  async boundary(onWaiting = async () => {}) {
    if (this.cancelRequested) return false;
    if (this.pauseRequested) {
      this.lifecycle = 'paused';
      const waiting = new Promise(resolve => { this.waiter = resolve; });
      this.emit('paused');
      await onWaiting();
      await waiting;
    }
    return !this.cancelRequested;
  }

  async waitForUserAction(reason, targetId, onWaiting = async () => {}) {
    if (this.cancelRequested) return false;
    this.lifecycle = 'waiting-for-user-action';
    const waiting = new Promise(resolve => { this.waiter = resolve; });
    this.emit('user-action-required', { reason, targetId });
    await onWaiting();
    await waiting;
    return !this.cancelRequested;
  }

  finish(lifecycle) {
    this.lifecycle = lifecycle;
    this.emit('job-finished');
  }
}

export function createJobController(options) {
  return new JobController(options);
}
