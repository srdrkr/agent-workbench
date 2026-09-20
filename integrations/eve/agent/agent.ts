import { defineAgent, defineDynamic } from 'eve';
import { createGateway } from 'ai';
import { mockModel } from 'eve/evals';
import { hostedTransportFromEnv, HOSTED_MODEL } from '../hosted/transport.js';
import { boundedModel } from '../bounded-model.js';
import { EVAL_MODEL } from '../eval-ledger.js';
import { evalTransport, locateCase } from '../eval-transport.js';

export default defineAgent({
  model: defineDynamic({
    events: {
      'step.started': (event, ctx) => {
        // The ordinary judgment is one model step. A durable Workflow replay is
        // a separate provider limitation, not an exactly-once promise.
        if (event.data.stepIndex !== 0) throw new Error('JUDGE_STEP_LIMIT');
        let model;
        if (process.env.WORKBENCH_EVE_MODE === 'fixture') {
          model = mockModel(({ tools, lastUserMessage }) => {
            const output = tools.find(tool => tool.name === 'final_output');
            if (tools.length !== 1 || !output) throw new Error('JUDGE_UNEXPECTED_TOOLS');
            const input = JSON.parse(lastUserMessage ?? '{}');
            const candidate = input.project?.codingCandidates?.[0];
            let proposal: { kind: 'coding' | 'commitment' | 'clarify'; candidateId: string | null;
              title: string; rationale: string; citations: string[]; question: string | null } = {
              kind: 'clarify', candidateId: null, title: 'Confirm the next priority',
              rationale: 'The synthetic fixture needs an owner priority decision.',
              citations: ['brief'], question: 'Which current commitment takes priority?',
            };
            if (/commitment/i.test(input.request ?? '')) {
              proposal = { kind: 'commitment', candidateId: null, title: 'Resolve the current blocker',
                rationale: 'Fixture proposal: review the blocker with the owner before committing more coding work.',
                citations: input.project.sources.map(source => source.id), question: null };
            } else if (candidate && !/blocker|blocked/i.test(input.request ?? '')) {
              proposal = { kind: 'coding', candidateId: candidate.id, title: candidate.title,
                rationale: 'Fixture proposal: choose the supplied bounded coding candidate and review its result before expanding scope.',
                citations: candidate.sourceIds, question: null };
            }
            return { toolCalls: [{ name: output.name, input: proposal }] };
          });
        } else if (['gateway-eval', 'gateway-eval-mock'].includes(process.env.WORKBENCH_EVE_MODE ?? '')) {
          const mock = process.env.WORKBENCH_EVE_MODE === 'gateway-eval-mock';
          if (!process.env.WORKBENCH_EVE_EVAL_LEDGER || (!mock && !process.env.AI_GATEWAY_API_KEY)) {
            throw new Error('JUDGE_GATEWAY_NOT_AUTHORIZED');
          }
          model = createGateway({ apiKey: mock ? 'synthetic-gateway-key' : process.env.AI_GATEWAY_API_KEY,
            fetch: evalTransport({ ledgerPath: process.env.WORKBENCH_EVE_EVAL_LEDGER,
              ...locateCase(ctx.messages), sessionId: ctx.session.id, mock }) })(EVAL_MODEL);
        } else if (process.env.WORKBENCH_EVE_MODE === 'hosted') {
          model = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY,
            fetch: hostedTransportFromEnv(ctx.messages, ctx.session.id) })(HOSTED_MODEL);
        } else {
          if (process.env.WORKBENCH_EVE_MODE !== 'gateway'
              || process.env.WORKBENCH_EVE_GATEWAY_APPROVED !== 'yes'
              || !process.env.AI_GATEWAY_API_KEY
              || !/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(process.env.WORKBENCH_EVE_MODEL ?? '')) {
            throw new Error('JUDGE_GATEWAY_NOT_AUTHORIZED');
          }
          model = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY })(process.env.WORKBENCH_EVE_MODEL!);
        }
        return { model: boundedModel(model), modelContextWindowTokens: 32_768 };
      },
    },
  }),
  limits: { maxInputTokensPerSession: 16_384, maxOutputTokensPerSession: 2048, sessionTimeoutMs: 60_000 },
});
