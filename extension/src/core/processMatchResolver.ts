import { RemoteTransport } from '../transport/remoteTransport';

export interface ProcessCandidate {
  pid: number;
  comm: string;
  cmdline: string;
  rssKb: number;
  score: number;
}

export interface ResolvedWatchRule {
  match: string;
  label: string;
  alias: string;
  reason: string;
  candidates: ProcessCandidate[];
  autoSelected: boolean;
}

const GENERIC_COMMS = new Set([
  'python',
  'python3',
  'python2',
  'node',
  'java',
  'bash',
  'sh',
  'dash',
  'ruby',
  'perl',
  'mono',
]);

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Scan /proc on remote for processes matching user query. */
export async function probeProcessCandidates(
  transport: RemoteTransport,
  userQuery: string
): Promise<ProcessCandidate[]> {
  const q = userQuery.trim();
  if (!q) {
    return [];
  }

  const script = `
q=$(echo ${shellEscape(q)} | tr '[:upper:]' '[:lower:]')
for d in /proc/[0-9]*; do
  [ -f "$d/status" ] || continue
  pid=$(basename "$d")
  comm=$(grep '^Name:' "$d/status" 2>/dev/null | awk '{print $2}')
  cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null | head -c 400)
  rss=$(grep '^VmRSS:' "$d/status" 2>/dev/null | awk '{print $2}')
  [ -n "$comm" ] || continue
  cl=$(echo "$comm $cmd" | tr '[:upper:]' '[:lower:]')
  case "$cl" in *"$q"*) echo "$pid|$comm|${rss:-0}|$cmd" ;; esac
done
`;

  let raw: string;
  try {
    raw = await transport.exec(`bash -lc ${shellEscape(script)}`);
  } catch {
    return [];
  }

  const qLower = q.toLowerCase();
  const candidates: ProcessCandidate[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const pipe = trimmed.indexOf('|');
    const pipe2 = trimmed.indexOf('|', pipe + 1);
    const pipe3 = trimmed.indexOf('|', pipe2 + 1);
    if (pipe < 0 || pipe2 < 0 || pipe3 < 0) {
      continue;
    }
    const pid = parseInt(trimmed.slice(0, pipe), 10);
    const comm = trimmed.slice(pipe + 1, pipe2);
    const rssKb = parseInt(trimmed.slice(pipe2 + 1, pipe3), 10) || 0;
    const cmdline = trimmed.slice(pipe3 + 1);

    let score = 0;
    const commLower = comm.toLowerCase();
    if (commLower === qLower) {
      score += 100;
    } else if (commLower.includes(qLower)) {
      score += 55;
    }
    if (cmdline.toLowerCase().includes(qLower)) {
      score += 35;
    }
    if (commLower.startsWith('systemd') && qLower !== 'systemd' && !qLower.includes('systemd')) {
      score -= 50;
    }
    score += Math.min(20, Math.floor(rssKb / 4096));

    candidates.push({ pid, comm, cmdline, rssKb, score });
  }

  candidates.sort((a, b) => b.score - a.score || b.rssKb - a.rssKb);
  return candidates;
}

function isGenericComm(comm: string): boolean {
  return GENERIC_COMMS.has(comm.toLowerCase());
}

function extractCmdlineToken(cmdline: string, query: string): string {
  const q = query.toLowerCase();
  for (const part of cmdline.split(/\s+/)) {
    if (!part || part.startsWith('-')) {
      continue;
    }
    if (part.toLowerCase().includes(q)) {
      if (part.includes('/')) {
        const base = part.split('/').filter(Boolean).find((s) => s.toLowerCase().includes(q));
        if (base && base.length >= q.length) {
          return base;
        }
        return part.length <= 96 ? part : query;
      }
      return part.length <= 48 ? part : query;
    }
  }
  return query;
}

function ruleFromComm(
  comm: string,
  userQuery: string,
  reason: string,
  candidates: ProcessCandidate[]
): ResolvedWatchRule {
  return {
    match: `=${comm}`,
    label: userQuery,
    alias: userQuery,
    reason,
    candidates,
    autoSelected: true,
  };
}

/** Generate optimal watch match rule from probe results and user intent. */
export function generateWatchRule(
  userQuery: string,
  candidates: ProcessCandidate[]
): ResolvedWatchRule {
  const q = userQuery.trim();
  const qLower = q.toLowerCase();

  if (candidates.length === 0) {
    const match = /^[a-zA-Z0-9._+-]+$/.test(q) && !q.includes('/') ? `=${q}` : q;
    return {
      match,
      label: q,
      alias: q,
      reason:
        'No running process matched. Saved rule for when the process starts (exact comm if name-like).',
      candidates: [],
      autoSelected: true,
    };
  }

  const best = candidates[0];
  const sameComm = candidates.filter((c) => c.comm === best.comm);

  if (best.comm.toLowerCase() === qLower) {
    return ruleFromComm(
      best.comm,
      q,
      `Exact comm "${best.comm}" (${sameComm.length} instance(s))`,
      candidates
    );
  }

  if (sameComm.length >= 1 && !isGenericComm(best.comm) && best.score >= 50) {
    return ruleFromComm(
      best.comm,
      q,
      `Resolved comm "${best.comm}" from ${sameComm.length} running instance(s)`,
      candidates
    );
  }

  if (isGenericComm(best.comm) || best.score < 80) {
    const token = extractCmdlineToken(best.cmdline, q);
    return {
      match: token,
      label: q,
      alias: q,
      reason: `Cmdline match (comm="${best.comm}", PID ${best.pid})`,
      candidates,
      autoSelected:
        candidates.filter((c) => c.cmdline.toLowerCase().includes(token.toLowerCase())).length <=
        3,
    };
  }

  return ruleFromComm(best.comm, q, `Best match comm "${best.comm}"`, candidates);
}

/** Probe remote and produce ranked watch rule options for user or AI. */
export async function resolveWatchRules(
  transport: RemoteTransport,
  userQuery: string
): Promise<{ recommended: ResolvedWatchRule; alternatives: ResolvedWatchRule[] }> {
  const candidates = await probeProcessCandidates(transport, userQuery);
  const recommended = generateWatchRule(userQuery, candidates);

  const alternatives: ResolvedWatchRule[] = [];
  const seen = new Set<string>([recommended.match]);

  const comms = [...new Set(candidates.slice(0, 8).map((c) => c.comm))];
  for (const comm of comms) {
    const match = `=${comm}`;
    if (seen.has(match)) {
      continue;
    }
    seen.add(match);
    const group = candidates.filter((c) => c.comm === comm);
    alternatives.push({
      match,
      label: userQuery,
      alias: userQuery,
      reason: `Exact comm "${comm}" (${group.length} instance(s))`,
      candidates: group,
      autoSelected: false,
    });
  }

  if (!seen.has(userQuery)) {
    alternatives.push({
      match: userQuery,
      label: userQuery,
      alias: userQuery,
      reason: 'Substring match (may include related processes)',
      candidates,
      autoSelected: false,
    });
  }

  return { recommended, alternatives: alternatives.slice(0, 5) };
}
