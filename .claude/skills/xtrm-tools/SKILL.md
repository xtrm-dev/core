```markdown
# xtrm-tools Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches the core development patterns, coding conventions, and collaborative workflows used in the `xtrm-tools` TypeScript monorepo. The repository focuses on extension management, CLI tooling, and package publishing, with a strong emphasis on maintainability, modularity, and clear documentation. By following these patterns, contributors can efficiently develop, refactor, and publish extensions and CLI features while maintaining consistency across the codebase.

## Coding Conventions

- **Language:** TypeScript
- **Framework:** None detected
- **File Naming:** camelCase for files and folders  
  _Example:_ `piRuntime.ts`, `skillsMaterializer.ts`
- **Import Style:** Relative imports  
  _Example:_
  ```ts
  import { someUtil } from '../shared/someUtil'
  ```
- **Export Style:** Mixed (both named and default exports)  
  _Example:_
  ```ts
  // Named export
  export function doSomething() { ... }

  // Default export
  export default MyComponent
  ```
- **Commit Message Prefixes:**  
  - `fix:`, `chore:`, `feat:`, `refactor:`, `docs:`
  - _Example:_ `feat: add registry sync script for extensions`
- **Documentation:**  
  - Each package and extension should have a `README.md`
  - Migration or architectural changes are documented in `MIGRATION_NOTES.md` or similar files

## Workflows

### Feature Branch Merge Workflow
**Trigger:** When a feature branch is ready to be integrated into main after development or migration work.  
**Command:** `/merge-feature-branch`

1. Complete feature or migration work on a dedicated branch.
2. Merge the branch into `main`, resolving any conflicts.
3. Commit the merge, which repeats the file changes from the feature branch.

_Files commonly involved:_
- `packages/pi-extensions/extensions/README.md`
- `packages/pi-extensions/package.json`
- `packages/pi-extensions/src/core/README.md`
- `packages/pi-extensions/src/index.ts`
- `cli/src/commands/pi-install.ts`
- `.xtrm/registry.json`
- and related extension/core files

### Package Metadata and Publish Workflow
**Trigger:** When preparing to publish a package, update its metadata, or after renaming a package.  
**Command:** `/publish-package`

1. Update `package.json` with new metadata or version.
2. Edit or create `README.md` for the package.
3. Update documentation files referencing the package.
4. Update or regenerate registry files (e.g., `.xtrm/registry.json`).
5. Update or run scripts that sync versions (e.g., `scripts/sync-cli-version.mjs`).
6. Publish the package to npm.

_Example:_
```jsonc
// package.json
{
  "name": "pi-extensions",
  "version": "1.2.0",
  "description": "Extension packages for xtrm-tools"
}
```

### Extension Migration or Bulk Refactor Workflow
**Trigger:** When performing a major migration or refactor of extension architecture or directory structure.  
**Command:** `/migrate-extensions`

1. Move or copy extension source files to new locations.
2. Update `package.json` and related metadata.
3. Update import paths and registry/index files.
4. Remove legacy or deprecated files and symlinks.
5. Update documentation to reflect new architecture.
6. Regenerate or update migration notes.

_Example:_
```ts
// Update import paths after moving files
import { coreUtil } from '../../core/coreUtil'
```

### CLI Runtime Update Workflow
**Trigger:** When changing how the CLI loads, installs, or manages extensions/packages.  
**Command:** `/update-cli-runtime`

1. Edit CLI command files to change extension/package logic.
2. Update core runtime scripts to handle new package names or migration logic.
3. Fix or migrate settings files to match new package structure.
4. Test CLI to ensure new logic works as intended.

_Files commonly involved:_
- `cli/src/commands/pi-install.ts`
- `cli/src/core/pi-runtime.ts`
- `cli/src/core/skills-materializer.ts`

### Documentation Sync and Update Workflow
**Trigger:** When the codebase or extension architecture changes significantly and documentation needs to be updated to match.  
**Command:** `/sync-docs`

1. Edit multiple documentation files to reflect new architecture or workflows.
2. Update `synced_at` timestamps or metadata in docs.
3. Validate documentation using scripts or drift detectors.
4. Commit all updated docs together.

_Example:_
```md
<!-- docs/pi-extensions.md -->
_Last synced: 2024-06-12_
```

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test File Pattern:** `*.test.ts`
- **Test Example:**
  ```ts
  // src/core/someUtil.test.ts
  import { describe, it, expect } from 'vitest'
  import { someUtil } from './someUtil'

  describe('someUtil', () => {
    it('should return expected result', () => {
      expect(someUtil(2)).toBe(4)
    })
  })
  ```
- **Location:** Test files are placed alongside source files or in relevant subdirectories.

## Commands

| Command                | Purpose                                                      |
|------------------------|--------------------------------------------------------------|
| /merge-feature-branch  | Merge a completed feature branch into main                   |
| /publish-package       | Prepare and publish a package, updating metadata and docs    |
| /migrate-extensions    | Perform bulk migration or refactor of extensions             |
| /update-cli-runtime    | Update CLI runtime logic for extension/package management    |
| /sync-docs             | Sync and update documentation after major changes            |
```
