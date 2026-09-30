// The saved draft or owner request supplies the original outcome, never a model title.
export function assignmentOutcome(source) {
  for (const outcome of [source?.assignmentDraft?.outcome, source?.message]) {
    if (typeof outcome === 'string' && outcome.trim()) return outcome;
  }
  return null;
}

// The outcome occupies the start of the composed objective. A later mention in
// copied context does not prove the owner's original outcome is still intact.
export const outcomePreserved = (objective, outcome) => typeof objective === 'string'
  && typeof outcome === 'string' && outcome.trim().length > 0 && (objective === outcome || objective.startsWith(`${outcome}\n`));
