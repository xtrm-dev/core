// Every contract schema, imported statically so bundlers inline them: a consumer that
// bundles this package (cli/dist) has no schemas/ directory to read at runtime.
// test/contracts.test.ts fails when this list and schemas/*.json drift apart.

import s0 from '../schemas/xtrm.agent-command.v1.json' with { type: 'json' };
import s1 from '../schemas/xtrm.agent-event.v1.json' with { type: 'json' };
import s2 from '../schemas/xtrm.agent-host-api.v1.json' with { type: 'json' };
import s3 from '../schemas/xtrm.agent-role-launched.v1.json' with { type: 'json' };
import s4 from '../schemas/xtrm.beads.lifecycle-event.v1.json' with { type: 'json' };
import s5 from '../schemas/xtrm.branch.integration.v1.json' with { type: 'json' };
import s6 from '../schemas/xtrm.command-deprecations.v1.json' with { type: 'json' };
import s7 from '../schemas/xtrm.command-outcome.v1.json' with { type: 'json' };
import s8 from '../schemas/xtrm.interactive-role-envelope.v1.json' with { type: 'json' };
import s9 from '../schemas/xtrm.pi-extension-manifest.v1.json' with { type: 'json' };
import s10 from '../schemas/xtrm.runtime-compatibility.v1.json' with { type: 'json' };
import s11 from '../schemas/xtrm.runtime-matrix.v1.json' with { type: 'json' };
import s12 from '../schemas/xtrm.runtime-origin.v1.json' with { type: 'json' };
import s13 from '../schemas/xtrm.specialist-role-envelope.v1.json' with { type: 'json' };
import s14 from '../schemas/xtrm.topology.projection.v1.json' with { type: 'json' };
import s15 from '../schemas/xtrm.xtmux.bridge.v1.json' with { type: 'json' };
import s16 from '../schemas/xtrm.xtmux.message.v1.json' with { type: 'json' };
import s17 from '../schemas/xtrm.xtmux.monitor.v1.json' with { type: 'json' };
import s18 from '../schemas/xtrm.xtmux.obligation.v1.json' with { type: 'json' };
import s19 from '../schemas/xtrm.xtmux.topology.v1.json' with { type: 'json' };
import s20 from '../schemas/xtrm.xtmux.wait.v1.json' with { type: 'json' };
import s21 from '../schemas/xtrm.agent-host-ensure.v1.json' with { type: 'json' };
import s22 from '../schemas/xtrm.agent-host-auth.v1.json' with { type: 'json' };

export const BUNDLED_SCHEMAS: readonly unknown[] = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, s21, s22];
