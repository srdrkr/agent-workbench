/**
 * Split decision records into those made under the active project revision
 * and those recorded under an earlier brief.
 *
 * Grouping uses strict equality between each record's `contextRevision` and
 * the active revision, matching the approval guards in the web UI. Records keep
 * their original relative order inside each group. The inputs are never
 * mutated: the returned groups are new arrays that reference the same record
 * objects, so historical records stay inspectable exactly as stored.
 *
 * @param {ReadonlyArray<{ contextRevision?: unknown }> | null | undefined} records
 * @param {unknown} activeRevision
 * @returns {{ current: Array<object>, historical: Array<object> }}
 */
export function splitDecisionHistory(records, activeRevision) {
  const current = [];
  const historical = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record !== null && typeof record === 'object' && record.contextRevision === activeRevision) current.push(record);
    else historical.push(record);
  }
  return { current, historical };
}
