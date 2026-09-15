# Verified improvement episodes

> Status: design proposal. This document defines a persistence and verification contract; it does **not** enable autonomous self-modification.

ClawMem is good at remembering what happened, what relates to what, and which memories later proved useful. A different class of memory is needed to answer a stricter question:

> **Which changes to an agent or its operating process were proposed, why were they proposed, how were they verified, and did the verified result deserve to influence later behavior?**

This proposal calls that record a **verified improvement episode**.

The motivation is deliberately narrower than “recursive self-improvement”. Retaining a change, a lesson, or a postmortem is not the same as learning that the change was beneficial. ClawMem should be able to preserve the provenance and verification state of an improvement without claiming that the host agent can safely modify itself.

The design is informed by recent work on recursive self-improvement, including *The Last AI Built by Humans: Toward Genuine Recursive Self-Improvement* (arXiv:2609.11873), but the feature proposed here is a memory primitive, not an RSI system.

## Problem

Today ClawMem can represent several pieces of an improvement story independently:

- observation documents capture evidence and events;
- `memory_relations` connects documents with semantic, supporting, contradicting, causal, and temporal edges;
- the causal writer stores causal evidence with append-only sightings and audit runs;
- the contradiction judge can gate mutation-authorizing decisions;
- the feedback loop measures whether surfaced memories were actually referenced;
- the eval harness can measure retrieval behavior.

What is missing is a first-class object that binds an **attempted improvement** into one auditable lifecycle.

Without such an object, a later agent can retrieve “we changed X” and “the test passed” but cannot reliably distinguish:

1. a hypothesis from an accepted improvement;
2. an accepted improvement from one later rolled back;
3. evidence that motivated a change from evidence that verified it;
4. a remembered change from a change whose benefit was actually demonstrated.

That distinction matters because **retention is not verification**.

## Goals

A verified improvement episode should:

1. preserve the reason a change was proposed;
2. link to the existing ClawMem documents that provide evidence, target context, verification evidence, inheritance evidence, or rollback evidence;
3. require explicit verification before an improvement can become accepted;
4. preserve rejected and rolled-back attempts rather than deleting them;
5. expose deterministic lifecycle state that other agents can query without reinterpreting prose;
6. remain host-agnostic: OpenClaw, Claude Code, Hermes, Codex, or another orchestrator can all use the same record;
7. fit beside the existing causal graph instead of creating a second competing graph.

## Non-goals

This proposal does **not**:

- allow an agent to rewrite its own code or prompts automatically;
- authorize deployment of a proposed change;
- execute tests or benchmarks;
- choose improvement goals autonomously;
- replace `memory_relations`, causal edges, the contradiction judge, or the eval harness;
- infer that a change is beneficial merely because it was retained or frequently recalled;
- claim support for recursive self-improvement.

Those capabilities, if ever added, should be separate policy-bearing layers built on top of this persistence contract.

## Why not another graph?

ClawMem already has graph semantics. Improvement episodes should **reference** the existing document and causal layers, not duplicate them.

An episode is best understood as a lifecycle/audit object that points into the graph:

```text
observation/evidence docs
        │
        ├── evidence ────────┐
        │                    ▼
        │          ┌─────────────────────┐
        └─────────▶│ Improvement episode │
                   └─────────────────────┘
                        │           │
                 verification   target/context
                        │           │
                        ▼           ▼
                 existing docs / causal graph
                        │
                 accepted / rejected
                        │
                 optional rollback
```

The existing graph answers questions such as “what caused this?” and “what is related?”. The improvement episode answers “what was the lifecycle and verification status of this attempted change?”.

## Lifecycle

The minimal lifecycle has four states:

```text
proposed ──verified success──▶ accepted ──later regression──▶ rolled_back
    │
    └──verified failure──────▶ rejected
```

### `proposed`

The episode records evidence, a hypothesis, and a proposed change. Nothing about this state implies that the change is correct, safe, deployed, or beneficial.

### `accepted`

The episode may enter `accepted` only when a non-empty verification record and outcome are persisted. “Accepted” means the evidence supplied to the verifier met the declared acceptance criterion. It does not mean ClawMem performed the change.

### `rejected`

The proposal was evaluated and did not meet its acceptance criterion, or verification showed it to be undesirable. Rejected episodes remain queryable because failed attempts are valuable procedural memory.

### `rolled_back`

An accepted improvement later produced sufficient contrary evidence to revoke its accepted status. Rollback is append-preserving: the original verification remains part of the record and rollback evidence is added rather than rewriting history.

`rejected` and `rolled_back` are terminal in the first implementation. A materially revised attempt should become a new episode linked to the previous one rather than reopening historical state.

## Proposed persistence model

The first implementation should use dedicated tables. This keeps lifecycle state explicit and prevents new pseudo-edge semantics from leaking into graph traversal before traversal has a reason to understand them.

### `improvement_episodes`

```sql
CREATE TABLE IF NOT EXISTS improvement_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'rejected', 'rolled_back')),

  evidence TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  proposed_change TEXT NOT NULL,

  verification TEXT,
  outcome TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0.0 AND confidence <= 1.0),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  rejected_at TEXT,
  rolled_back_at TEXT,
  rollback_reason TEXT,

  CHECK (
    status NOT IN ('accepted', 'rejected') OR
    (length(trim(COALESCE(verification, ''))) > 0 AND
     length(trim(COALESCE(outcome, ''))) > 0)
  ),
  CHECK (
    status != 'rolled_back' OR
    (accepted_at IS NOT NULL AND
     rolled_back_at IS NOT NULL AND
     length(trim(COALESCE(rollback_reason, ''))) > 0)
  )
);
```

`evidence`, `hypothesis`, `proposed_change`, `verification`, and `outcome` are intentionally text in v1. Structured benchmark payloads can live in linked documents, while the episode remains human-readable and portable.

`episode_key` is caller-supplied or generated once and is stable across retries. It provides idempotency without using mutable prose as identity.

### `improvement_episode_links`

```sql
CREATE TABLE IF NOT EXISTS improvement_episode_links (
  episode_id INTEGER NOT NULL
    REFERENCES improvement_episodes(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL
    REFERENCES documents(id) ON DELETE RESTRICT,
  role TEXT NOT NULL
    CHECK (role IN ('evidence', 'target', 'verification', 'inheritance', 'rollback')),
  detail TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (episode_id, document_id, role)
);
```

Roles are deliberately small and explicit:

- `evidence` — observation or other memory that motivated the proposal;
- `target` — memory describing the component, policy, prompt, workflow, or system being improved;
- `verification` — benchmark, test result, review, or other evidence used to resolve the proposal;
- `inheritance` — evidence that an accepted change was subsequently retained or adopted by the host system;
- `rollback` — evidence that justified revoking a previously accepted improvement.

An `inheritance` link must **not** be interpreted as proof that the host actually changed unless the linked document establishes that fact. ClawMem records evidence; it does not fabricate deployment state.

## State-transition invariants

The API must enforce transitions rather than exposing raw status updates.

Allowed transitions:

```text
proposed -> accepted
proposed -> rejected
accepted -> rolled_back
```

Disallowed examples:

```text
accepted -> rejected
rejected -> accepted
rolled_back -> accepted
proposed -> rolled_back
```

Additional invariants:

1. `accepted` and `rejected` require non-empty `verification` and `outcome`.
2. `rolled_back` requires a prior `accepted_at`, a rollback timestamp, a non-empty rollback reason, and at least one rollback evidence link before the transition commits.
3. confidence is always bounded to `[0, 1]` and is supplied by the verifying caller; ClawMem must not silently invent confidence.
4. status transitions and their evidence links should commit transactionally.
5. no hard delete API should be exposed for episodes. Historical attempts are part of the audit trail.
6. every mutation updates `updated_at`; original timestamps are never overwritten.

## Proposed TypeScript surface

A first implementation can stay intentionally small:

```ts
export type ImprovementStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'rolled_back';

export type ImprovementLinkRole =
  | 'evidence'
  | 'target'
  | 'verification'
  | 'inheritance'
  | 'rollback';

export function createImprovementEpisode(
  db: Database,
  input: CreateImprovementEpisodeInput,
): ImprovementEpisode;

export function linkImprovementDocument(
  db: Database,
  episodeId: number,
  documentId: number,
  role: ImprovementLinkRole,
  detail?: string,
): void;

export function resolveImprovementEpisode(
  db: Database,
  episodeId: number,
  result: {
    status: 'accepted' | 'rejected';
    verification: string;
    outcome: string;
    confidence: number;
    verificationDocumentIds?: number[];
  },
): ImprovementEpisode;

export function rollbackImprovementEpisode(
  db: Database,
  episodeId: number,
  input: {
    reason: string;
    rollbackDocumentIds: number[];
  },
): ImprovementEpisode;

export function getImprovementEpisode(
  db: Database,
  episodeId: number,
): ImprovementEpisode | null;

export function listImprovementEpisodes(
  db: Database,
  opts?: { status?: ImprovementStatus; limit?: number },
): ImprovementEpisode[];
```

The persistence module should depend only on `bun:sqlite`. It should not make LLM calls and should not depend on a particular host agent.

## Relationship to the judge

The existing contradiction judge is useful precedent but should not be silently reused as an “improvement judge”. Its current contract answers a different question: whether facts are the same, updates, or contradictions.

A later PR may introduce a verifier adapter that uses the configured judge transport while defining a separate verification schema. That adapter should return evidence to `resolveImprovementEpisode`; it should not bypass the lifecycle API or mutate host configuration directly.

This separation keeps three responsibilities distinct:

1. **persistence** — ClawMem stores the episode and its provenance;
2. **verification** — a benchmark, deterministic test, reviewer, or LLM judge evaluates evidence;
3. **execution/inheritance** — a host system decides whether and how to apply an accepted improvement.

## Relationship to causal memory

Improvement episodes do not replace causal edges.

A causal edge may establish, for example:

```text
routing-policy change -> fewer timeout failures
```

An improvement episode can cite the documents behind that causal relationship as verification evidence and record that the proposed policy change was accepted. The causal graph remains responsible for causal retrieval; the episode remains responsible for lifecycle state.

In a later integration, `intent_search` may optionally boost accepted improvement episodes when the query asks for “what fixed”, “what improvement worked”, or “what was rolled back”. That retrieval behavior should be evaluated separately before changing ranking.

## Relationship to the feedback loop

The current feedback loop measures whether recalled memories were referenced. That is a useful **utility signal**, not proof that a system change improved performance.

A frequently recalled rejected proposal must remain rejected. An accepted improvement must not lose its verification state merely because it is rarely recalled. Utility and verification are separate axes.

## Safety boundary

The most important property of this design is what it refuses to do.

Persisting `status='accepted'` is **not authority to execute a change**.

Any future host integration that turns an accepted episode into a code, prompt, model, tool, or configuration mutation must define its own policy controls, permissions, canary/rollback behavior, and independent verification. The persistence layer should remain usable even in environments where autonomous mutation is forbidden.

This makes verified improvement memory useful today without smuggling an autonomous self-modification mechanism into a memory engine.

## Acceptance tests for the implementation PR

The implementation should not be merged until tests cover at least the following:

1. creating an episode persists `proposed` state and stable identity;
2. duplicate `episode_key` creation is idempotent or fails explicitly according to one documented policy — never silently creates a second episode;
3. empty evidence, hypothesis, or proposed change is rejected;
4. confidence outside `[0, 1]` is rejected;
5. an episode cannot become `accepted` without non-empty verification and outcome;
6. an episode cannot become `rejected` without non-empty verification and outcome;
7. only `proposed -> accepted|rejected` and `accepted -> rolled_back` are allowed;
8. rollback fails if no rollback evidence document is supplied;
9. link roles outside the canonical enum are rejected;
10. document links enforce referential integrity;
11. resolving an episode and adding verification links is atomic;
12. rollback and rollback evidence insertion is atomic;
13. no hard-delete code path is introduced;
14. existing causal, judge, graph, memory, and retrieval tests remain unchanged and green.

## Implementation sequence

Keep the work in small PRs:

### PR 1 — design contract

This document only. Agree on semantics before adding schema or user-visible tools.

### PR 2 — persistence primitive

Add the two tables, typed TypeScript API, and unit tests. No hook, MCP, CLI, or ranking integration.

### PR 3 — retrieval/tool surface

Expose read/query operations through the appropriate ClawMem surface. Evaluate whether episodes should be returned directly or projected through existing document retrieval.

### PR 4 — optional verifier integration

Only after the persistence semantics are stable, add an explicit verifier adapter. Deterministic tests/benchmarks should remain first-class; an LLM judge is one verifier, not the definition of verification.

### Later — host-specific inheritance

OpenClaw, Claude Code, Hermes, or another orchestrator may choose to consume accepted episodes. That policy belongs to the host integration, not to the core memory primitive.

## Design principle

ClawMem should be able to remember more than **what changed**.

It should be able to remember **why a change was attempted, what evidence tested it, whether that evidence justified acceptance, and whether later evidence forced a rollback**.

That is a useful memory primitive on its own. It is also the minimum trustworthy substrate for any future system that wants to learn from its own attempted improvements without confusing persistence with progress.
