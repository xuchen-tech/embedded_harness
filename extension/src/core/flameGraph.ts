/** Parse perf script output into folded stacks: "a;b;c" -> sample count */

function parseFrame(line: string): string {
  const trimmed = line.trim();
  const symMatch = trimmed.match(/^[0-9a-fA-Fx]+\s+(.+?)(?:\s+\(|$)/);
  if (symMatch) {
    return symMatch[1].replace(/\+0x[0-9a-fA-F]+$/, '').trim();
  }
  return trimmed.replace(/\+0x[0-9a-fA-F]+$/, '').trim();
}

export function collapsePerfScript(script: string): Array<{ stack: string; count: number }> {
  const counts = new Map<string, number>();
  let frames: string[] = [];

  const flush = (): void => {
    if (frames.length === 0) {
      return;
    }
    const folded = [...frames].reverse().join(';');
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
    frames = [];
  };

  for (const raw of script.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s+\S/.test(line)) {
      const frame = parseFrame(line);
      if (frame && frame !== '[unknown]') {
        frames.push(frame);
      }
    } else if (frames.length > 0) {
      flush();
    }
  }
  flush();

  return [...counts.entries()]
    .map(([stack, count]) => ({ stack, count }))
    .sort((a, b) => b.count - a.count);
}

interface FlameNode {
  name: string;
  value: number;
  children: Map<string, FlameNode>;
}

function buildTree(folded: Array<{ stack: string; count: number }>): FlameNode {
  const root: FlameNode = { name: 'root', value: 0, children: new Map() };
  for (const { stack, count } of folded) {
    if (!stack) {
      continue;
    }
    const parts = stack.split(';').filter(Boolean);
    let node = root;
    root.value += count;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, value: 0, children: new Map() });
      }
      node = node.children.get(part)!;
      node.value += count;
    }
  }
  return root;
}

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderFlame(
  node: FlameNode,
  x: number,
  y: number,
  width: number,
  lines: string[],
  maxDepth: number
): void {
  const rowH = 18;
  if (width < 0.5 || y > maxDepth * rowH + 200) {
    return;
  }
  if (node.name !== 'root') {
    const color = hashColor(node.name);
    lines.push(
      `<rect x="${x.toFixed(1)}" y="${y}" width="${width.toFixed(1)}" height="${rowH}" fill="${color}" stroke="#1e1e1e" stroke-width="0.5">` +
        `<title>${escapeXml(node.name)} (${node.value} samples)</title></rect>`
    );
    if (width > 24) {
      const label =
        node.name.length > Math.floor(width / 5)
          ? node.name.slice(0, Math.floor(width / 5)) + '…'
          : node.name;
      lines.push(
        `<text x="${(x + 2).toFixed(1)}" y="${y + 12}" font-size="10" fill="#fff" font-family="sans-serif">${escapeXml(label)}</text>`
      );
    }
  }

  const children = [...node.children.values()].sort((a, b) => b.value - a.value);
  let cx = x;
  const denom = node.value || 1;
  for (const ch of children) {
    const w = (ch.value / denom) * width;
    renderFlame(ch, cx, y + (node.name === 'root' ? 0 : rowH), w, lines, maxDepth);
    cx += w;
  }
}

export function generateFlameSvg(
  folded: Array<{ stack: string; count: number }>,
  title: string
): string {
  if (folded.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="120"><text x="10" y="40">No stack samples captured. Try sudo perf or install debug symbols.</text></svg>`;
  }

  const tree = buildTree(folded);
  const maxDepth = Math.min(
    32,
    Math.max(...folded.map((f) => f.stack.split(';').length), 1)
  );
  const width = 960;
  const height = maxDepth * 18 + 48;
  const lines: string[] = [];
  renderFlame(tree, 0, 28, width, lines, maxDepth);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#1e1e1e"/>
  <text x="8" y="18" fill="#ccc" font-size="13" font-family="sans-serif">${escapeXml(title)}</text>
  ${lines.join('\n  ')}
</svg>`;
}
