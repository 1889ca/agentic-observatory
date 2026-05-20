# Multi-Step Action Plan Approval

> Bundle related actions into a single numbered plan with per-step approval tiers, so the user approves all, some, or none in one decision instead of being interrupted N times.

## Problem

When an agent decides on a batch of related actions ("comment on 8 stale PRs, close 3 abandoned ones, merge 4 green ones"), single-action approval forces the user through N modal decisions in a row. The user loses context between approvals, can't see the shape of the overall plan before consenting, and inevitably starts rubber-stamping to clear the queue. The agent loses the ability to express "these go together" — and the user loses the ability to say "yes to 1 and 3, no to 2."

## Context

- The agent often generates batches of related actions from one analysis pass (PR triage, inbox cleanup, calendar sync)
- Actions in a batch may have different risk tiers — some can NOTIFY (do it, tell the user), others must ASK (wait for explicit approval)
- The user wants to see the whole plan as a coherent unit, not be interrupted action-by-action
- Partial approval is a first-class case: "yes to the safe ones, ask me again about the risky ones"
- Plans must execute only the approved subset, leaving rejected steps as a record of what was declined

## Solution

A plan is a row in `action_plans` with N child rows in `plan_steps`. Each step has a `tier` (NOTIFY or ASK) and an `approved` field that is `null` until the user decides. The plan's overall `status` reflects the aggregate decision: `pending`, `partial`, `approved`, `rejected`, or `executed`.

### Plan Structure

```javascript
// action_plans:  id, status, created_at, approved_at, description
// plan_steps:    id, plan_id, position, description, tier, approved (nullable bool)

const PLAN_STATUS = {
  PENDING:   'pending',    // no decisions yet
  PARTIAL:   'partial',    // some steps decided, others still pending
  APPROVED:  'approved',   // all decided, at least one approved — ready to execute
  REJECTED:  'rejected',   // all steps rejected
  EXECUTED:  'executed',   // approved subset has been run
}
```

### Creation: One Plan, N Tiered Steps

```javascript
await plans.createPlan({
  description: 'Triage 15 stale PRs',
  steps: [
    { description: 'Comment "needs rebase" on 8 PRs', tier: 'NOTIFY' },
    { description: 'Close 3 abandoned PRs with explanation', tier: 'ASK' },
    { description: 'Merge 4 green PRs after CI passes', tier: 'ASK' },
  ],
})
```

The tier per step matters: when the user approves the whole plan, NOTIFY steps execute immediately and ASK steps still require a separate confirmation. Mixing tiers in one plan is the point — the agent can bundle "obvious cleanup" with "judgment call" without splitting them into two plans.

### Partial Approval

`approvePlan(planId, stepIds)` approves only the listed steps. The plan's new status is computed from the aggregate:

```javascript
async function approvePlan(planId, stepIds = null) {
  if (stepIds && stepIds.length > 0) {
    for (const stepId of stepIds) {
      await update('plan_steps', { approved: true }, 'id = ?', stepId)
    }

    const allSteps = await select('plan_steps').where('plan_id = ?', planId).all()
    const allDecided = allSteps.every(s => s.approved !== null)
    const allApproved = allSteps.every(s => s.approved === true)
    const allRejected = allSteps.every(s => s.approved === false)

    let newStatus = PLAN_STATUS.PARTIAL
    if (allApproved)      newStatus = PLAN_STATUS.APPROVED
    else if (allRejected) newStatus = PLAN_STATUS.REJECTED
    else if (allDecided)  newStatus = PLAN_STATUS.APPROVED  // mixed, some approved

    await update('action_plans', { status: newStatus, ... }, 'id = ?', planId)
  } else {
    // Approve every still-pending step
    await update('plan_steps', { approved: true }, 'plan_id = ? AND approved IS NULL', planId)
    await update('action_plans', { status: PLAN_STATUS.APPROVED, ... }, 'id = ?', planId)
  }
}
```

The interesting state is PARTIAL: "the user has said something but not everything." This lets the UI render "3 decided, 2 still need your call" rather than forcing a single yes/no on the whole plan.

### Rejection With the Same Granularity

`rejectPlan(planId, stepIds, reason)` mirrors approval. Rejecting some steps while leaving others pending leaves the plan in PARTIAL — the user can come back later. Rejecting all steps marks the plan REJECTED and persists the reason for the audit trail.

### Execution: Approved Subset Only

`executePlan(planId)` iterates over steps with `approved === true` and runs them in order. Steps with `approved === false` are skipped but remain in the plan as a record:

```javascript
async function executePlan(planId) {
  const plan = await getPlan(planId)
  for (const step of plan.steps) {
    if (step.approved !== true) continue
    await runStep(step)
  }
  await update('action_plans', { status: PLAN_STATUS.EXECUTED, ... }, 'id = ?', planId)
}
```

### Event Emission

`plan.approved` and `plan.rejected` events fire on every state change with a `partialApproval` flag so subscribers (dashboard, audit, notification) can react differently to "fully decided" vs. "still in flight":

```javascript
unifiedEvents.emit('plan.approved', {
  planId, plan: updatedPlan, tenantId,
  partialApproval: stepIds && stepIds.length > 0,
})
```

## Implications

- **One decision moment instead of N** — the user sees the whole plan once and chooses; the agent doesn't fragment its reasoning across N approval prompts
- **Per-step tier preserves safety** — bundling does not collapse to the lowest tier; ASK steps still ASK even inside an approved plan
- **PARTIAL is a stable state** — the user can decide some steps now and others later without the plan timing out or getting auto-rejected
- **Rejected steps stay in the plan** — they're a record of "the user said no to this", which matters for audit and for the agent learning what not to propose next time
- **The agent must propose coherent batches** — if the steps aren't related, the plan loses its value as a unit; this pushes the agent toward better analysis pass design
- **Plans don't auto-execute on creation** — even an all-NOTIFY plan waits for `approvePlan` then `executePlan`, keeping the user as the single trigger

## Code Example

```javascript
const plans = require('./lib/agent/plans')

// Agent: after analyzing the inbox, proposes a bundled plan
const plan = await plans.createPlan({
  description: '15 stale PRs found — triage plan',
  steps: [
    { description: 'Comment "needs rebase" on 8 PRs', tier: 'NOTIFY' },
    { description: 'Close 3 abandoned PRs (>90 days, no activity)', tier: 'ASK' },
    { description: 'Merge 4 green PRs after final CI pass', tier: 'ASK' },
  ],
})

console.log(plans.formatPlan(plan))
// Renders the numbered list with tier badges

// User: "do 1 and 3, ask me again about 2"
await plans.approvePlan(plan.id, [plan.steps[0].id, plan.steps[2].id])
await plans.rejectPlan(plan.id, [plan.steps[1].id], 'want to review individually')

// Plan now APPROVED (decisions complete, some approved)
await plans.executePlan(plan.id)
// → step 1 (NOTIFY) and step 3 (ASK, pre-approved by plan) run; step 2 skipped
```

## Related Patterns

- [Decision Gating and Autonomy Tiers](./decision-gating-and-autonomy-tiers.md)
- [Confidence-Based Autonomy Gating](./confidence-based-autonomy-gating.md)
- [Implicit Approval Parsing](./implicit-approval-parsing.md)
- [Attention Item Management](./attention-item-management.md)
