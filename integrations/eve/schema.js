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
