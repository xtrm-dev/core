# Spec or PRD to runnable board

For a large spec, audit report, or multi-repo goal:

1. Ground the spec against current default branches and recent work.
2. Separate already-delivered claims from real residual work.
3. Identify repo/service ownership and cross-repo promotion gates.
4. Decompose by coherent deliverable/PR boundary, not by file or document heading.
5. Compute overlap before deciding parallel lanes.
6. Create only dependencies required for execution order.
7. Put shared requirements on the nearest common parent instead of copying prose into
   every child.
8. Attach test/operational evidence to the work that owns the behavior.
9. Keep any human-facing plan document compact; the Substrate Issue is execution truth.

For very large or risky specs, use an independent read-only critique before materializing
the board. The critic should verify claims against current source, challenge unnecessary
abstractions, and identify missing coupling.