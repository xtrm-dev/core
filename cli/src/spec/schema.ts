import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 1 as const;

const kebab = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case lowercase ASCII');

const scrutinyEnum = z.enum(['low', 'medium', 'high', 'critical']);
const statusEnum = z.enum(['draft', 'validated', 'planned', 'archived']);
const layerEnum = z.enum(['core', 'boundary', 'shell', 'operational']);
const validationKindEnum = z.enum(['unit', 'integration', 'smoke', 'e2e', 'telemetry']);

const RequirementSchema = z.object({
    id: z.string().regex(/^R\d+$/, 'must match R<number> (R1, R2, ...)'),
    story: z.string().min(1),
    behavior: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    layer_hint: layerEnum.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    risks: z.array(z.string()).optional(),
});

const ValidationItemSchema = z.object({
    kind: validationKindEnum,
    target: z.string().min(1),
});

const DependencySchema = z.object({
    from: z.string().regex(/^R\d+$/),
    requires: z.string().regex(/^R\d+$/),
});

const LinksSchema = z.object({
    parent_epic: z.string().nullable().optional(),
    planner_bead: z.string().nullable().optional(),
    epic: z.string().nullable().optional(),
    children: z.array(z.string()).default([]),
    test_issues: z.array(z.string()).default([]),
});

export const SpecV1Schema = z.object({
    schema_version: z.literal(CURRENT_SCHEMA_VERSION),
    id: kebab,
    title: z.string().min(1).max(200),
    status: statusEnum,
    scrutiny: scrutinyEnum,

    problem: z.string().min(1),
    success: z.array(z.string().min(1)).min(1),

    scope: z.object({
        include: z.array(z.string().min(1)).min(1),
        exclude: z.array(z.string()).default([]),
    }),

    non_goals: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),

    requirements: z.array(RequirementSchema).min(1),
    validation: z.array(ValidationItemSchema).default([]),
    dependencies: z.array(DependencySchema).default([]),
    open_questions: z.array(z.string()).default([]),

    links: LinksSchema.default({ children: [], test_issues: [] }),
});

export type SpecV1 = z.infer<typeof SpecV1Schema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type ValidationItem = z.infer<typeof ValidationItemSchema>;
export type Dependency = z.infer<typeof DependencySchema>;
export type Links = z.infer<typeof LinksSchema>;
export type Scrutiny = z.infer<typeof scrutinyEnum>;
export type SpecStatus = z.infer<typeof statusEnum>;
export type Layer = z.infer<typeof layerEnum>;
export type ValidationKind = z.infer<typeof validationKindEnum>;

export function toJSONSchemaV1(): Record<string, unknown> {
    const schema = z.toJSONSchema(SpecV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
    schema.$id = 'https://xtrm.dev/schemas/spec-v1.json';
    schema.title = 'xtrm spec.yaml v1';
    schema.description =
        'Versioned intent artifact for xt spec. PRD-level inputs that compile to a planner bead via xt spec apply.';
    return schema;
}
