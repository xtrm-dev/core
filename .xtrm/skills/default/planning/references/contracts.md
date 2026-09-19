# XTRM work contracts

## Ready contract

Every dispatchable work item answers:

```text
PROBLEM
Why this exists. State the defect, missing capability, or decision pressure in real prose.

SUCCESS
Observable conditions that mean the work is complete.

SCOPE
Owned files/systems/behaviors. Be specific enough to prevent accidental expansion.

NON_GOALS
Nearby work deliberately excluded.

CONSTRAINTS
Compatibility, safety, ownership, architecture, rollout, or implementation invariants.

VALIDATION
Exact checks/evidence expected. Include integrated behavior where it matters.

OUTPUT
Durable result the worker must leave: code/commit, report, Journal result, artifact, etc.
```

Optional sections: `LIBRARIES`, `REFERENCES`, `SCRUTINY`, `TELEMETRY`, `ROLLBACK`,
`DEPENDENCIES`.

## Draft capture

A draft is permitted for deferred ideas. It still requires a real `PROBLEM` and rough
`SCOPE`; unknown sections explicitly say they need exploration. Keep it as a draft Issue (no attestation, no claim).

A draft may not be dispatched. Before dispatch:

1. re-read current state;
2. explore enough to replace unknowns;
3. rewrite the contract in place;
4. attest it ready (`sb issue attest <ref> --outcome ready --policy <p> --attested-by <who>`);
5. re-read the final contract as the recipient would see it.

## New work discovered mid-execution

Apply the durability test before creating anything: independently assignable,
blockable, resumable, reviewable, closable? YES -> child/follow-up Issue
(`sb issue create --parent <ref> ...`). NO -> Journal entry on the owning Issue
(`sb journal append <ref> --kind finding|decision|blocker`). Never mutate the Issue
contract for routine progress; never file a child Issue for analysis, test runs, or a
normal Specialist result. A Specialist result belongs to settlement/Journal/provenance,
never to an appended contract note.

## Contract quality test

Ask: could a fresh competent worker with repository access execute this without the
current chat transcript? If not, the missing information belongs in the durable contract
or a referenced artifact.

Do not compensate for a weak contract by adding a second private prompt during dispatch.