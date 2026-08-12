import { SessionManager } from './session';
import { HistoryStore } from './historyStore';

let sessions: SessionManager | undefined;
let history: HistoryStore | undefined;

export function setHarnessContext(s: SessionManager, h: HistoryStore): void {
  sessions = s;
  history = h;
}

export function getSessionManager(): SessionManager | undefined {
  return sessions;
}

export function getHistoryStore(): HistoryStore | undefined {
  return history;
}

export function getHistoryStoreOrThrow(): HistoryStore {
  if (!history) {
    throw new Error('Harness context not initialized');
  }
  return history;
}

export function getSessionManagerOrThrow(): SessionManager {
  if (!sessions) {
    throw new Error('Harness context not initialized');
  }
  return sessions;
}
