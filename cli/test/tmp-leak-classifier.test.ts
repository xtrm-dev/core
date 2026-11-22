import { describe, expect, it } from 'vitest';

import {
  classifyEntries,
  describeForeign,
  formatAge,
  ownPrefixesFromSources,
  type Ownership,
  type TmpEntry,
} from './tmp-leak-classifier';

// CORE-2758: the guard used to fail a shared-temp run on every entry under a
// blanket `xtrm-` family. The fixture below is the exact case that reddened
// CORE-2754's first CI run: the suite creates only `xt-bundle-*` directories and
// a payload-hygiene script leaves `xtrm-payload-*` behind.

const shared = (overrides: Partial<Ownership> = {}): Ownership => ({
  dedicated: false,
  registered: [],
  ownPrefixes: ['xt-bundle-'],
  ...overrides,
});

const entry = (name: string, ageSeconds = 12): TmpEntry => ({ name, ageSeconds });

describe('tmp-leak ownership classifier', () => {
  it('fails a shared run on a prefix its own sources create', () => {
    const { leaked, foreign } = classifyEntries([entry('xt-bundle-abc123')], shared());
    expect(leaked).toEqual(['xt-bundle-abc123']);
    expect(foreign).toEqual([]);
  });

  it('fails a shared run on a directory the sandbox registry names', () => {
    const { leaked, foreign } = classifyEntries(
      [entry('xtrm-cli-home-KjcpBj')],
      shared({ registered: ['xtrm-cli-home-KjcpBj'], ownPrefixes: [] }),
    );
    expect(leaked).toEqual(['xtrm-cli-home-KjcpBj']);
    expect(foreign).toEqual([]);
  });

  it('warns instead of failing on a foreign prefix another process owns', () => {
    // `xtrm-payload-` appears only in scripts/check-payload-hygiene.mjs, never in
    // cli's own test sources, so this suite cannot be its author.
    const { leaked, foreign } = classifyEntries(
      [entry('xtrm-payload-WrORTi'), entry('xtrm-noapp-z1sOCD', 90)],
      shared({ ownPrefixes: ['xt-bundle-', 'xtrm-noapp-'] }),
    );
    expect(leaked).toEqual(['xtrm-noapp-z1sOCD']);
    expect(foreign.map(item => item.name)).toEqual(['xtrm-payload-WrORTi']);
  });

  it('keeps every new entry fatal in a dedicated temp dir', () => {
    const { leaked, foreign } = classifyEntries(
      [entry('xtrm-payload-WrORTi'), entry('unrelated.txt')],
      shared({ dedicated: true, registered: [] }),
    );
    expect(leaked).toEqual(['xtrm-payload-WrORTi', 'unrelated.txt']);
    expect(foreign).toEqual([]);
  });

  it('names the entry and its age so a real leak stays visible', () => {
    expect(describeForeign([entry('xtrm-payload-WrORTi', 12), entry('other', 3700)])).toBe(
      'xtrm-payload-WrORTi (12s old), other (1h old)',
    );
    expect(formatAge(45)).toBe('45s old');
    expect(formatAge(120)).toBe('2m old');
    expect(formatAge(172800)).toBe('2d old');
    expect(formatAge(Number.NaN)).toBe('unknown age');
  });

  it('derives prefixes from whatever the sources actually call mkdtemp with', () => {
    const prefixes = ownPrefixesFromSources(['src/tests', 'test']);
    expect(prefixes).toContain('xtrm-noapp-');
    expect(prefixes).toContain('xtrm-cli-home-');
    expect(prefixes).not.toContain('xtrm-payload-');
  });
});
