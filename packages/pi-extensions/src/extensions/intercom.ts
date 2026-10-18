import registerExtension from "../../extensions/intercom/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomExtensionOptions } from "../../extensions/intercom/index.ts";

/**
 * Managed production entry: the intercom extension with agent-host
 * self-healing on (CORE-2467 A). Package-level tests keep it off.
 */
export default function registerIntercomExtension(
  pi: ExtensionAPI,
  options: IntercomExtensionOptions = {},
): void {
  registerExtension(pi, { hostEnsure: true, ...options });
}
