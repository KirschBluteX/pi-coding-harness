import type { MemoryEngine } from "./engine.js";
import type { MemoryIndexDrainResult } from "./types.js";

export class MemoryIndexDrainer {
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastFailure: string | null = null;

  constructor(
    private readonly engine: MemoryEngine,
    private readonly debounceMs: number,
    private readonly onFailure: (message: string) => void = () => undefined,
  ) {}

  schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      let failure: string | null = null;
      try {
        this.engine.flushTelemetry();
      } catch (error) {
        failure = error instanceof Error ? error.message : "Memory telemetry flush failed";
      }
      try {
        this.engine.drainIndex();
      } catch (error) {
        failure = error instanceof Error ? error.message : "Memory index drain failed";
      }
      this.lastFailure = failure;
      if (failure) this.onFailure(failure);
    }, this.debounceMs);
    this.timer.unref();
  }

  flushNow(): MemoryIndexDrainResult {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    let telemetryFailure: string | null = null;
    try {
      this.engine.flushTelemetry();
    } catch (error) {
      telemetryFailure = error instanceof Error ? error.message : "Memory telemetry flush failed";
      this.onFailure(telemetryFailure);
    }
    const result = this.engine.drainIndex();
    if (telemetryFailure) this.lastFailure = telemetryFailure;
    else this.lastFailure = null;
    return result;
  }

  failure(): string | null {
    return this.lastFailure;
  }

  close(): MemoryIndexDrainResult {
    this.closed = true;
    return this.flushNow();
  }
}
