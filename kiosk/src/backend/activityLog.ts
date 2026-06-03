export interface LogEntry {
  freq: number;
  alphaTag: string;
  ts: number;
}

export class ActivityLog {
  private buf: LogEntry[] = [];
  constructor(private readonly capacity: number) {}

  add(entry: LogEntry): void {
    this.buf.unshift(entry);
    if (this.buf.length > this.capacity) this.buf.length = this.capacity;
  }

  entries(): LogEntry[] {
    return this.buf.slice();
  }
}
