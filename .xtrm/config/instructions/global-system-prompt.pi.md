<!-- DEPRECATED (XT-138/XT-139, CORE-2476): Pi doctrine no longer ships through
this managed block. The versioned vehicle is the xtrm-primer per-turn injection
(MARKER-guarded; packages/pi-extensions/extensions/xtrm-primer/index.ts), which
folds this file's old router content with the CORE-2475 audit fixes applied.
The installer leaves ~/.pi/agent/APPEND_SYSTEM.md untouched: existing files keep
working through the transition and project .pi/APPEND_SYSTEM.md overrides keep
Pi-native precedence. This asset is retained only so older installers resolve
to a pointer instead of stale doctrine. -->

Pi system-prompt doctrine moved into the xtrm-primer extension: the primer injects
the folded always-on rules per turn (Pi 1.3.0) instead of this file. Safe to remove
the managed block from ~/.pi/agent/APPEND_SYSTEM.md once the primer is active.
