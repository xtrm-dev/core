import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkPiSdkResolution, isAtLeast } from '../check-pi-sdk-resolution.mjs';

const PACKAGES = { '@earendil-works/pi-coding-agent': '1.0.0' };

function installFake(dir, name, version) {
    const pkgDir = path.join(dir, 'node_modules', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
}

function fixture() {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sdk-resolution-'));
    const repoRoot = path.join(outer, 'repo');
    const fromDir = path.join(repoRoot, 'packages', 'pi-extensions');
    fs.mkdirSync(fromDir, { recursive: true });
    return { outer, repoRoot, fromDir };
}

test('isAtLeast compares numeric semver triples', () => {
    assert.equal(isAtLeast('1.0.0', '1.0.0'), true);
    assert.equal(isAtLeast('1.2.0-beta.1', '1.0.0'), true);
    assert.equal(isAtLeast('0.84.4', '1.0.0'), false);
    assert.equal(isAtLeast('0.99.2', '1.0.0'), false);
    assert.equal(isAtLeast('not-a-version', '1.0.0'), false);
});

test('passes on an in-repo 1.0.0 copy', () => {
    const { repoRoot, fromDir } = fixture();
    installFake(repoRoot, '@earendil-works/pi-coding-agent', '1.0.0');
    const { errors, resolved } = checkPiSdkResolution({ fromDir, repoRoot, packages: PACKAGES });
    assert.deepEqual(errors, []);
    assert.equal(resolved[0].location, path.join(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent'));
});

test('fails on a simulated in-repo 0.84 resolution', () => {
    const { repoRoot, fromDir } = fixture();
    installFake(repoRoot, '@earendil-works/pi-coding-agent', '0.84.4');
    const { errors } = checkPiSdkResolution({ fromDir, repoRoot, packages: PACKAGES });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /0\.84\.4: below required 1\.0\.0/);
});

test('fails when resolution walks up to a parent-directory 0.84 copy', () => {
    const { outer, repoRoot, fromDir } = fixture();
    installFake(outer, '@earendil-works/pi-coding-agent', '0.84.4');
    const { errors } = checkPiSdkResolution({ fromDir, repoRoot, packages: PACKAGES });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /resolved outside the repo/);
    assert.match(errors[1], /below required 1\.0\.0/);
});

test('fails when the package is not installed anywhere on the walk', () => {
    const { repoRoot, fromDir } = fixture();
    const { errors } = checkPiSdkResolution({
        fromDir,
        repoRoot,
        packages: { '@earendil-works/pi-not-a-real-package-xtrm586': '1.0.0' },
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not installed/);
});
