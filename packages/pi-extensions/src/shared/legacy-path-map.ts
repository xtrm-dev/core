export interface ExtensionPathMapping {
  readonly extensionId: string;
  readonly legacyPath: string;
  readonly newPath: string;
}

export const LEGACY_PATH_MAPPINGS: readonly ExtensionPathMapping[] = [
  { extensionId: "beads", legacyPath: ".xtrm/ext-src/beads", newPath: "packages/pi-extensions/extensions/beads" },
  { extensionId: "compact-header", legacyPath: ".xtrm/ext-src/compact-header", newPath: "packages/pi-extensions/extensions/compact-header" },
  { extensionId: "custom-footer", legacyPath: ".xtrm/ext-src/custom-footer", newPath: "packages/pi-extensions/extensions/custom-footer" },
  { extensionId: "git-checkpoint", legacyPath: ".xtrm/ext-src/git-checkpoint", newPath: "packages/pi-extensions/extensions/git-checkpoint" },
  { extensionId: "quality-gates", legacyPath: ".xtrm/ext-src/quality-gates", newPath: "packages/pi-extensions/extensions/quality-gates" },
  { extensionId: "service-knowledge", legacyPath: ".xtrm/ext-src/service-knowledge", newPath: "packages/pi-extensions/extensions/service-knowledge", note: "relocated to xtrm repo package @jaggerxtrm/pi-service-knowledge (xtrm-6z6.5)" },
  { extensionId: "session-flow", legacyPath: ".xtrm/ext-src/session-flow", newPath: "packages/pi-extensions/extensions/session-flow" },
  { extensionId: "xtrm-ui", legacyPath: ".xtrm/ext-src/xtrm-ui", newPath: "packages/pi-extensions/extensions/xtrm-ui" },
  { extensionId: "pi-core-internal", legacyPath: ".xtrm/ext-src/core", newPath: "packages/pi-extensions/src/core" },
] as const;
