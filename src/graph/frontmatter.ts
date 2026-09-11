import { CLAIM_STATUS, ExtractedClaim, ExtractedEntity } from './store.js';

/**
 * Tier-0 declarative extraction: documents may carry explicit `entities:` and
 * `claims:` lists in their YAML frontmatter (news feeds, imported facts, seed
 * data). They are applied through the same path as tier-1 LLM extraction, so
 * time-bound validity (startDate/endDate) and status (fact/disputed) work
 * without any LLM configured.
 *
 * ```yaml
 * entities:
 *   - { name: 宁德时代, type: organization, aliases: ["300750"] }
 * claims:
 *   - subject: 宁德时代
 *     statement: 2026Q2 净利润 120 亿元
 *     status: disputed
 *     startDate: "2026-08-10"
 * ```
 */
export function frontmatterExtraction(fm: Record<string, unknown>): { entities: ExtractedEntity[]; claims: ExtractedClaim[] } | null {
  const rawClaims = Array.isArray(fm.claims) ? fm.claims : [];
  const rawEntities = Array.isArray(fm.entities) ? fm.entities : [];
  if (rawClaims.length === 0 && rawEntities.length === 0) return null;

  const entities: ExtractedEntity[] = [];
  const known = new Set<string>();
  const addEntity = (e: ExtractedEntity) => {
    const key = e.name.trim().toLowerCase();
    if (!key || known.has(key)) return;
    known.add(key);
    entities.push(e);
  };

  for (const raw of rawEntities) {
    if (typeof raw === 'string' && raw.trim()) {
      addEntity({ name: raw.trim(), type: 'concept' });
    } else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!name) continue;
      addEntity({
        name,
        type: typeof o.type === 'string' ? o.type : 'concept',
        description: typeof o.description === 'string' ? o.description : undefined,
        aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : undefined,
      });
    }
  }

  const claims: ExtractedClaim[] = [];
  for (const raw of rawClaims) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const subject = typeof o.subject === 'string' ? o.subject.trim() : '';
    const statement = typeof o.statement === 'string' ? o.statement.trim() : '';
    if (!subject || !statement) continue;
    const status = typeof o.status === 'string' && (CLAIM_STATUS as readonly string[]).includes(o.status) ? o.status : 'fact';
    claims.push({
      subject,
      object: typeof o.object === 'string' ? o.object : null,
      type: typeof o.type === 'string' && o.type.trim() ? o.type.trim() : 'fact',
      statement,
      status: status as ExtractedClaim['status'],
      startDate: dateStr(o.startDate ?? o.start_date),
      endDate: dateStr(o.endDate ?? o.end_date),
    });
    // claim subjects must resolve to an extracted entity, so ensure one exists
    addEntity({ name: subject, type: 'concept' });
    if (typeof o.object === 'string' && o.object.trim()) addEntity({ name: o.object.trim(), type: 'concept' });
  }

  if (entities.length === 0 && claims.length === 0) return null;
  return { entities, claims };
}

function dateStr(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}
