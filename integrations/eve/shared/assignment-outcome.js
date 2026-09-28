// The outcome occupies the start of the composed objective. A later mention in
// copied context does not prove the owner's original outcome is still intact.
export const outcomePreserved = (objective, outcome) => typeof objective === 'string'
  && typeof outcome === 'string' && (objective === outcome || objective.startsWith(`${outcome}\n`));
