/**
 * Intercom Pi transport (CORE-2433 I2, XT-91 ADR rev 2 + amendment 1)
 * with the Claude transport adapter (CORE-2434 I3).
 *
 * Registers one listener per Pi session through the shared agent-host
 * connection (`ensureAgentHostBridge`): a second active entry never opens a
 * second listener, and an in-process child session (native specialist) gets
 * its own binding instead of replacing its parent's. Inbound wakes inject
 * with `pi.sendMessage` as `customType: "intercom_message"` and are
 * acknowledged only after the injection succeeded (see ./delivery.ts).
 * The Claude side (./claude-transport) registers the Pi session in Claude's
 * registry behind an ownership check, so Pi sessions appear in Claude Code's
 * ListAgents while pi-claude-link coexists until M1.
 *
 * This slice carries no model tools (ListAgents/SendMessage are I4/I5,
 * CORE-2435/CORE-2436) and no card renderer beyond the plain fallback (I7,
 * CORE-2438). It never registers the names xtrm-ui owns (bash, read, edit,
 * write, find, grep, ls).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentHostBridgeOptions, ensureAgentHostBridge } from "../xtrm-agent-host/index.ts";
import claudeTransportExtension, { type ClaudeTransportOptions } from "./claude-transport/index.ts";

export {
  buildIntercomWakeContent,
  buildIntercomWakeDetails,
  injectIntercomWake,
  INTERCOM_MESSAGE_TYPE,
  MAX_TRACKED_WAKES,
  PROVENANCE_LINE,
  wakeDeliveryOptions,
  WakeDedupe,
} from "./delivery.ts";
export type { WakeDelivery } from "./delivery.ts";

export interface IntercomExtensionOptions extends AgentHostBridgeOptions {
  /** Socket override forwarded to the Claude transport (tests). */
  claudeSocketPath?: string;
  /** Registry override forwarded to the Claude transport (tests). */
  claudeSessionsDir?: string;
}

export type { ClaudeTransportOptions };

export default function intercomExtension(pi: ExtensionAPI, options: IntercomExtensionOptions = {}): void {
  ensureAgentHostBridge(pi, options).register();
  claudeTransportExtension(pi, {
    ...(options.claudeSocketPath ? { socketPath: options.claudeSocketPath } : {}),
    ...(options.claudeSessionsDir ? { sessionsDir: options.claudeSessionsDir } : {}),
  });
}
