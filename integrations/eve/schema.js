import { z } from 'zod';

export const proposalSchema = z.strictObject({
  kind: z.enum(['coding', 'commitment', 'clarify', 'plan']),
  candidateId: z.string().min(1).max(120).nullable(),
  title: z.string().min(1).max(240),
  rationale: z.string().min(1).max(2000),
  citations: z.array(z.string().min(1).max(120)).min(1).max(12),
  question: z.string().min(1).max(500).nullable(),
});

export const codeReviewSchema = z.strictObject({
  verdict: z.enum(['ready', 'correct', 'blocked']),
  summary: z.string().min(1).max(500),
  findings: z.array(z.strictObject({
    path: z.string().min(1).max(240),
    line: z.number().int().positive(),
    problem: z.string().min(1).max(500),
  })).max(5),
});

// Opt-in assignment drafting (application mode `assignment_draft`). A separate schema
// keeps ordinary requests, their byte-based reservations and the eval fixtures unchanged.
// Sizes keep the whole output within the existing 2048-token cap. The server re-validates
// every field against the approved context (hosted/assignment-draft.js); nothing here
// grants scope or authority.
export const assignmentDraftSchema = z.strictObject({
  sourceRefs: z.array(z.strictObject({ sourceId: z.string().min(1).max(64), why: z.string().min(1).max(120) })).min(1).max(4)
    .describe('Supplied source IDs that scope the work.'),
  files: z.array(z.strictObject({ path: z.string().min(1).max(200), why: z.string().min(1).max(120) })).max(8)
    .describe('Exact relative file paths named in supplied sources or candidates only. Empty if none is named.'),
  acceptanceExamples: z.array(z.string().min(1).max(200)).min(1).max(4).describe('Observable examples of done.'),
  verification: z.array(z.string().min(1).max(160)).min(1).max(4).describe('Concrete checks.'),
});
export const draftProposalSchema = proposalSchema.extend({
  draft: assignmentDraftSchema.nullable().describe('Only with kind plan: an assignment draft for owner review. The application keeps the owner request verbatim as the outcome; do not reword it. Do not ask to reconfirm a priority the context already settles. If a fact needed for scope is missing or contradictory, use kind clarify with one focused question and draft null.'),
});
