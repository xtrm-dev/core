import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertPackageShape(packageJson, filePath) {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error(`Invalid package.json shape at ${filePath}: expected object`);
  }

  if (typeof packageJson.name !== 'string') {
    throw new Error(`Invalid package.json shape at ${filePath}: missing string name`);
  }

  if (
    packageJson.dependencies !== undefined &&
    (typeof packageJson.dependencies !== 'object' ||
      Array.isArray(packageJson.dependencies) ||
      packageJson.dependencies === null)
  ) {
    throw new Error(
      `Invalid package.json shape at ${filePath}: dependencies must be object when present`,
    );
  }
}

const packagePath = path.resolve('package.json');
const packageJson = readJson(packagePath, 'package.json');
assertPackageShape(packageJson, packagePath);

const selfDependency = packageJson.dependencies?.['xtrm-tools'];
if (selfDependency) {
  throw new Error(`package.json depends on itself via xtrm-tools@${selfDependency}`);
}

const lockPath = path.resolve('package-lock.json');
if (fs.existsSync(lockPath)) {
  const lockJson = readJson(lockPath, 'package-lock.json');
  const rootDeps = lockJson?.packages?.['']?.dependencies;
  if (
    rootDeps &&
    typeof rootDeps === 'object' &&
    !Array.isArray(rootDeps) &&
    rootDeps['xtrm-tools']
  ) {
    throw new Error(
      `package-lock.json root still depends on itself via xtrm-tools@${rootDeps['xtrm-tools']}`,
    );
  }
}

console.log('ok: no self-dependency');
