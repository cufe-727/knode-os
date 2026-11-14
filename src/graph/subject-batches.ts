/**
 * Subjects packed into batches for the passes that walk every claim (the
 * duplicate-claim audit, supersession by attribute): claims are only ever
 * compared within one canonical subject, so such a pass reads a batch of
 * whole subjects, works on it and lets it go before the next — its heap holds
 * a batch, not the table.
 */

/** Subjects whose claims are read and worked on together. */
export interface SubjectBatch {
  /** Canonical subjects: each one's claims are all in the batch. */
  subjects: Set<string>;
  /** The entity ids their claims name them by (a merged entity's claims keep its own id). */
  subjectIds: string[];
  /** Claims of those subjects. */
  claims: number;
}

/**
 * Pack subjects, in id order, into batches of at most `size` claims; a subject
 * with more claims than that is a batch alone. `rows`: one per entity id the
 * claims name, with the canonical subject it stands for and its claims.
 */
export function packSubjectBatches(rows: { subject_id: string; subject: string; n: number }[], size: number): SubjectBatch[] {
  const bySubject = new Map<string, { ids: string[]; n: number }>();
  for (const r of rows) {
    const s = bySubject.get(r.subject) ?? bySubject.set(r.subject, { ids: [], n: 0 }).get(r.subject)!;
    s.ids.push(r.subject_id);
    s.n += r.n;
  }
  const batches: SubjectBatch[] = [];
  let batch: SubjectBatch = { subjects: new Set(), subjectIds: [], claims: 0 };
  for (const [subject, s] of [...bySubject].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (batch.claims > 0 && batch.claims + s.n > Math.max(1, size)) {
      batches.push(batch);
      batch = { subjects: new Set(), subjectIds: [], claims: 0 };
    }
    batch.subjects.add(subject);
    batch.subjectIds.push(...s.ids);
    batch.claims += s.n;
  }
  if (batch.claims > 0) batches.push(batch);
  return batches;
}
