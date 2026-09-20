# Current work

## Completed locally

Hosted brief promotion, exact coding approval, durable Routines dispatch and GitHub evidence reconciliation are implemented and independently reviewed. Existing owner web and Telegram paths are implemented. Live configuration is private and must be inspected before claiming it is active.

## First application assignment

Improve the web Decisions view so current-project decisions and earlier-project decisions are visibly separate. Preserve original ordering within each group and show a clear empty current-state message. Historical records remain inspectable. Do not change approval conditions, API calls, dispatch, authentication, accounting or context state.

Bounded files: `integrations/eve/app/app.vue`, a new pure `integrations/eve/app/utils/decision-history.js`, and `integrations/eve/test/decision-history.test.js`. The helper should group by equality with the active project revision without mutating its inputs. Regression coverage should include mixed revisions, empty/current-only/history-only inputs and stable ordering. Pass both CI jobs and return a draft PR with the supplied task marker.

This document defines a candidate, not execution authority. The exact approved base revision, branch, task ID, routine and scope are bound by the hosted approval record. No other feature, refactor, dependency, merge or deployment belongs in this assignment.

## Later

Complete the observed loop and owner review before starting another task. Automatic result monitoring, context synchronization and SMS remain future work.
