import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { toJSONSchemaV1 } from '../src/spec/schema.js';

const out = resolve(import.meta.dirname, '../src/spec/schema.json');
const json = toJSONSchemaV1();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(json, null, 2) + '\n', 'utf8');
console.log(`wrote ${out}`);
