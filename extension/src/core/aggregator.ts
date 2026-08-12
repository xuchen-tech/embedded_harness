import { LogEntry } from '../types';

const MAX_TIMELINE = 2000;

export class LogAggregator {
  private entries: LogEntry[] = [];

  push(entries: LogEntry[]): number {
    if (entries.length === 0) {
      return 0;
    }
    this.entries.push(...entries);
    this.entries.sort((a, b) => a.timestamp - b.timestamp);
    let dropped = 0;
    if (this.entries.length > MAX_TIMELINE) {
      dropped = this.entries.length - MAX_TIMELINE;
      this.entries = this.entries.slice(-MAX_TIMELINE);
    }
    return dropped;
  }

  getAll(): LogEntry[] {
    return [...this.entries];
  }

  getFiltered(filter?: {
    source?: string;
    level?: string;
    keyword?: string;
  }): LogEntry[] {
    return this.entries.filter((e) => {
      if (filter?.source && e.source !== filter.source) {
        return false;
      }
      if (filter?.level && e.level !== filter.level) {
        return false;
      }
      if (filter?.keyword && !e.message.toLowerCase().includes(filter.keyword.toLowerCase())) {
        return false;
      }
      return true;
    });
  }

  clear(): void {
    this.entries = [];
  }
}
