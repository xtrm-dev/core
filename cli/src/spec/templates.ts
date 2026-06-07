// Templates inlined as TS strings so tsup bundles them into dist/.
// SSOT lives here. A test asserts renderTemplate output parses + zod-validates.

export const MINIMAL_TEMPLATE = `# yaml-language-server: $schema=__SCHEMA_PATH__
schema_version: 1
id: __SLUG__
title: __TITLE__
status: draft
scrutiny: medium

problem: >
  TODO — describe the user/project problem this spec exists to solve.

success:
  - TODO — observable end-state

scope:
  include:
    - TODO — cli/src/foo/bar.ts
  exclude: []

non_goals: []
constraints: []

requirements:
  - id: R1
    story: TODO — as a <role> I want <capability> so that <outcome>
    behavior: TODO — behavior in observable terms
    acceptance:
      - TODO — concrete falsifiable check
    layer_hint: shell

validation: []
dependencies: []
open_questions: []

links:
  parent_epic: null
  planner_bead: null
  epic: null
  children: []
  test_issues: []
`;

export const FULL_TEMPLATE = `# yaml-language-server: $schema=__SCHEMA_PATH__
schema_version: 1
id: __SLUG__
title: __TITLE__
status: draft
scrutiny: medium

problem: >
  TODO — describe the user/project problem this spec exists to solve.
  Why now. What breaks if we don't ship it.

success:
  - TODO — observable end-state 1
  - TODO — observable end-state 2

scope:
  include:
    - TODO — cli/src/foo/bar.ts
    - TODO — cli/src/foo/baz.ts
  exclude:
    - TODO — adjacent surface explicitly left out

non_goals:
  - TODO — related improvement explicitly out of scope

constraints:
  - TODO — API / wire-format compatibility rule
  - TODO — logging contract (event names, fields, redaction)
  - TODO — do-not-touch boundary

requirements:
  - id: R1
    story: TODO — as a <role> I want <capability> so that <outcome>
    behavior: TODO — behavior in observable terms
    acceptance:
      - TODO — concrete falsifiable check
      - TODO — regression-prevention assertion
    layer_hint: shell
    priority: 2
    risks:
      - TODO — known failure mode to design against
  - id: R2
    story: TODO — second user story
    behavior: TODO — behavior
    acceptance:
      - TODO — concrete falsifiable check
    layer_hint: operational

validation:
  - kind: unit
    target: TODO — what unit-tests cover
  - kind: integration
    target: TODO — what integration-tests cover
  - kind: telemetry
    target: TODO — which log/metric event presence is asserted

dependencies:
  - from: R2
    requires: R1

open_questions:
  - TODO — unresolved question (must be empty before xt spec apply at high/critical scrutiny)

links:
  parent_epic: null
  planner_bead: null
  epic: null
  children: []
  test_issues: []
`;

export type TemplateName = 'minimal' | 'full';

export function getTemplate(name: TemplateName): string {
    return name === 'full' ? FULL_TEMPLATE : MINIMAL_TEMPLATE;
}

export interface TemplateVars {
    slug: string;
    title: string;
    schemaPath: string;
}

export function renderTemplate(name: TemplateName, vars: TemplateVars): string {
    return getTemplate(name)
        .replace(/__SLUG__/g, vars.slug)
        .replace(/__TITLE__/g, vars.title)
        .replace(/__SCHEMA_PATH__/g, vars.schemaPath);
}
