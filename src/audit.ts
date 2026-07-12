import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL audit logger.
 *
 * Writes one JSON object per line to a file, giving MCP traffic the structured,
 * greppable observability the protocol has no native hook for. Each entry is
 * stamped with an ISO timestamp and a monotonic sequence number. Writes are
 * synchronous appends so the trail survives an abrupt exit; failures are
 * swallowed so auditing can never take down the proxy.
 */
export class AuditLogger {
  private seq = 0;
  private ready = false;

  constructor(private readonly filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      this.ready = true;
    } catch {
      // If the directory can't be created, log() becomes a no-op.
      this.ready = false;
    }
  }

  /** Append one audit entry. `type` categorizes the event; `data` is merged in. */
  log(type: string, data: Record<string, unknown>): void {
    if (!this.ready) return;
    const entry = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      type,
      ...data,
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    } catch {
      // Never let an audit write failure propagate into the request path.
    }
  }
}
