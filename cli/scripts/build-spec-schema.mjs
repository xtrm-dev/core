#!/usr/bin/env node
// Regenerates cli/src/spec/schema.json from the zod source of truth.
// Run via: npx tsx scripts/build-spec-schema.ts (from cli/)
// This wrapper delegates to the TS entry so we don't dual-maintain logic.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'build-spec-schema.ts');
const result = spawnSync('npx', ['tsx', entry], { stdio: 'inherit', cwd: resolve(here, '..') });
process.exit(result.status ?? 1);
