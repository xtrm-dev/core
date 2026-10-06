import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import compactHeaderExtension from "./extensions/compact-header.ts";
import customFooterExtension from "./extensions/custom-footer.ts";
import gitCheckpointExtension from "./extensions/git-checkpoint.ts";
import qualityGatesExtension from "./extensions/quality-gates.ts";
import serviceSkillsExtension from "./extensions/service-skills.ts";
import xtrmLoaderExtension from "./extensions/xtrm-loader.ts";
import xtrmUiExtension from "./extensions/xtrm-ui.ts";

export type ManagedPiExtension = {
  readonly id: string;
  readonly register: (pi: ExtensionAPI) => void;
};

export const managedPiExtensions: readonly ManagedPiExtension[] = [
  { id: "compact-header", register: compactHeaderExtension },
  { id: "custom-footer", register: customFooterExtension },
  { id: "git-checkpoint", register: gitCheckpointExtension },
  { id: "quality-gates", register: qualityGatesExtension },
  { id: "service-skills", register: serviceSkillsExtension },
  { id: "xtrm-loader", register: xtrmLoaderExtension },
  { id: "xtrm-ui", register: xtrmUiExtension },
];

function registerManagedExtension(pi: ExtensionAPI, extension: ManagedPiExtension): void {
  try {
    extension.register(pi);
  } catch (error) {
    console.warn(`[pi-extensions] Failed to register '${extension.id}':`, error);
  }
}

export function registerManagedPiExtensions(pi: ExtensionAPI): void {
  for (const extension of managedPiExtensions) {
    registerManagedExtension(pi, extension);
  }
}
