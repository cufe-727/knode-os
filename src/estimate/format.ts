import type { Range, TaskEstimate } from './estimate.js';

/** An estimate as a terminal shows it (`knode-os estimate`). The web UI and the Mac app draw the same fields. */

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} days`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`;
  return String(Math.round(tokens));
}

export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

const percent = (p: number) => (p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`);

/** "≈ 4.2 h (3.1–7.8 h)": the expected value, then the range when it says something. */
export function formatRange(r: Range, f: (n: number) => string): string {
  const lo = f(r.low);
  const hi = f(r.high);
  return lo === hi ? `≈ ${f(r.expected)}` : `≈ ${f(r.expected)} (${lo} – ${hi})`;
}

export function formatEstimate(e: TaskEstimate): string {
  const out: string[] = [];
  out.push(`${e.title} — estimate, ${e.at.slice(0, 16).replace('T', ' ')} UTC`);
  for (const w of e.work) out.push(`  ${w.label}: ${w.detail}`);
  const t = e.totals;
  out.push('');
  out.push(`  Time       ${t.seconds ? formatRange(t.seconds, formatDuration) : 'nothing has a slot to run on'}`);
  out.push(`  Calls      ${t.calls.toLocaleString('en-US')}`);
  out.push(`  Tokens     in ${formatRange(t.tokens.input, formatTokens)} (${formatTokens(t.tokens.cached)} from cache) · out ${formatRange(t.tokens.output, formatTokens)}`);
  out.push(`  Transfer   ↑ ${formatRange(t.bytes.up, formatBytes)} · ↓ ${formatRange(t.bytes.down, formatBytes)}${t.bytes.remote.expected > 0 ? ` · remote workers' own ${formatRange(t.bytes.remote, formatBytes)}` : ''}`);
  out.push(`  Cost       ${t.costUsd ? `${formatRange(t.costUsd, formatUsd)} at API prices` : 'no price known'}${t.costUsd && t.unpriced.length ? ` (not counting ${t.unpriced.join(', ')})` : ''}`);
  for (const s of e.services) {
    out.push('');
    out.push(`  ${s.label}${s.plan ? ` (${s.plan})` : ''} — ${s.calls.toLocaleString('en-US')} calls, ${formatTokens(s.tokens.input)} in / ${formatTokens(s.tokens.output)} out${s.costUsd ? `, ${formatRange(s.costUsd, formatUsd)}` : ''}`);
    for (const w of s.windows) {
      const now = w.usedPercent !== null ? `${percent(w.usedPercent)} used${w.resetsAt ? `, resets ${w.resetsAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` : '';
      const task = w.taskPercent ? `this task ${formatRange(w.taskPercent, percent)}` : 'this task: not estimated';
      out.push(`    ${w.name} window: ${[now, task].filter(Boolean).join(' · ')}`);
      out.push(`      ${w.basis}`);
    }
    if (s.credits) out.push(`    credits: ${s.credits.unlimited ? 'unlimited' : s.credits.balance !== null ? s.credits.balance.toLocaleString('en-US', { maximumFractionDigits: 0 }) : s.credits.hasCredits ? 'yes' : 'none'}`);
    if (s.limitReached) out.push(`    limit reached: ${s.limitReached}`);
    for (const n of s.notes) out.push(`    · ${n}`);
  }
  if (e.lines.length) {
    out.push('');
    out.push('  By route:');
    for (const l of e.lines) {
      const basis = [l.perCall.basis.tokens === 'measured' ? `tokens measured over ${l.perCall.basis.measuredCalls} calls` : 'tokens estimated', l.perCall.basis.time === 'measured' ? 'time measured' : 'time by default'].join(', ');
      out.push(`    ${l.label} · ${l.route}${l.remote ? ' (remote)' : ''} × ${l.slots || 'no'} slot${l.slots === 1 ? '' : 's'}: ${l.calls.toLocaleString('en-US')} calls, ${formatTokens(l.perCall.input)} in / ${formatTokens(l.perCall.output)} out and ${formatDuration(l.perCall.seconds.expected)} each — ${basis}`);
    }
  }
  if (e.notes.length) {
    out.push('');
    for (const n of e.notes) out.push(`  · ${n}`);
  }
  return out.join('\n');
}
