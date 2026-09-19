# Delegated worker

Use this reference when this agent is a child/peer executing a contract for another XTRM
participant.

1. Resolve your durable Issue/contract (pinned revision + readiness/claim) and current workspace before doing work.
2. Restate internally: success, scope, non-goals, validation, output, and parent/owner.
3. Do not expand into sibling work without updating the durable contract or requesting a
   decision.
4. Record material progress as Journal entries on the owning Issue; send short status pointers through the
   active native message channel.
5. If blocked on a parent decision, send one correlated decision request and ensure a
   continuation/wakeup exists.
6. If you spawn your own worker, you become responsible for that child lifecycle and must
   return one consolidated outcome upward.
7. Verify your own output before sending `done`; state checks that failed or were skipped.
8. Do not merge/push/deploy/close parent-owned work unless the contract grants that
   authority.

If context pressure becomes unsafe, follow `/using-xtrm` (Continuity) and leave a
handoff that the parent or replacement worker can consume without this transcript.