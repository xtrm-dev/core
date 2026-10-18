/**
 * Intercom Pi transport (CORE-2433 I2, XT-91 ADR rev 2 + amendment 1)
 * with the Claude transport adapter (CORE-2434 I3) and the ListAgents
 * roster (CORE-2435 I4).
 *
 * Registers one listener per Pi session through the shared agent-host
 * connection (`ensureAgentHostBridge`): a second active entry never opens a
 * second listener, and an in-process child session (native specialist) gets
 * its own binding instead of replacing its parent's. Inbound wakes inject
 * with `pi.sendMessage` as `customType: "intercom_message"` and are
 * acknowledged only after the injection succeeded (see ./delivery.ts).
 * The Claude side (./claude-transport) registers the Pi session in Claude's
 * registry behind an ownership check — off by default, enabled per machine
 * by setting intercom.claudeTransport — so Pi sessions appear in Claude
 * Code's ListAgents with no competing writer post-M1 (a live foreign entry
 * keeps the transport off).
 *
 * This slice adds the model-only ListAgents tool (./roster.ts: this
 * session's name first, then one Claude-shaped row per Pi and Claude peer),
 * the /intercom roster overlay and /rename (./commands.ts), and the
 * waiting-only footer chip (./waiting.ts). Sending is I5 (CORE-2436), the
 * card renderer is I7 (CORE-2438). It never registers the names xtrm-ui
 * owns (bash, read, edit, write, find, grep, ls).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentHostBridgeOptions, ensureAgentHostBridge } from "../xtrm-agent-host/index.ts";
import claudeTransportExtension, { type ClaudeTransportOptions } from "./claude-transport/index.ts";
import { registerIntercomCommands, type IntercomCommandDeps } from "./commands.ts";
import { registerListAgentsTool, type ListAgentsDeps } from "./roster.ts";
import { registerSendMessageTool, type SendMessageDeps } from "./sendmessage.ts";
import { intercomWaiting, registerIntercomFooter } from "./waiting.ts";
import { INTERCOM_MESSAGE_TYPE } from "./delivery.ts";
import { registerEventRenderer, type EventDetails } from "../../shared/event.ts";

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

export interface IntercomExtensionOptions extends AgentHostBridgeOptions, SendMessageDeps {
  /** Socket override forwarded to the Claude transport (tests). */
  claudeSocketPath?: string;
  /** Registry override forwarded to the Claude transport (tests). */
  claudeSessionsDir?: string;
  /** Force the Claude transport on/off (tests, M1); default reads settings. */
  claudeTransportEnabled?: boolean;
}

export type { ClaudeTransportOptions };
export { intercomWaiting } from "./waiting.ts";
export type { IntercomCommandDeps, RenameResult } from "./commands.ts";
export type { ListAgentsDeps, ResolveMiss, RosterEntry, RosterRow } from "./roster.ts";
export type { AttachmentFileRead, AttachmentInput, SendMessageDeps, SendMessageDetails, SendScope, WakeSendRequest } from "./sendmessage.ts";
export { applySendScope, MAX_ATTACHMENTS, MAX_FILE_ATTACH_BYTES, MAX_FILE_READ_BYTES, MAX_INLINE_ATTACH_BYTES, MAX_PAYLOAD_BYTES } from "./sendmessage.ts";

export default function intercomExtension(pi: ExtensionAPI, options: IntercomExtensionOptions = {}): void {
  ensureAgentHostBridge(pi, options).register();
  // Our bound Claude socket, when the transport holds one: the uds:
  // return address for receipts (CORE-2465). Null while unbound.
  let boundClaudeSocket: string | undefined;
  claudeTransportExtension(pi, {
    ...(options.claudeSocketPath ? { socketPath: options.claudeSocketPath } : {}),
    ...(options.claudeSessionsDir ? { sessionsDir: options.claudeSessionsDir } : {}),
    ...(options.claudeTransportEnabled !== undefined ? { enabled: options.claudeTransportEnabled } : {}),
    onSocketPath: (sockPath) => {
      boundClaudeSocket = sockPath ?? undefined;
    },
  });
  const rosterDeps: ListAgentsDeps & IntercomCommandDeps = {
    ...(options.claudeSocketPath ? { excludeSock: options.claudeSocketPath } : {}),
    ...(options.claudeSessionsDir ? { sessionsDir: options.claudeSessionsDir } : {}),
  };
  registerListAgentsTool(pi, rosterDeps);
  registerIntercomCommands(pi, rosterDeps);
  registerSendMessageTool(pi, {
    ...(options.claudeSocketPath ? { excludeSock: options.claudeSocketPath } : {}),
    ...(options.claudeSessionsDir ? { sessionsDir: options.claudeSessionsDir } : {}),
    ...(options.claudeTransportEnabled !== undefined ? { claudeTransportEnabled: options.claudeTransportEnabled } : {}),
    getClaudeSocketPath: () => boundClaudeSocket,
  });
  registerIntercomFooter(intercomWaiting);
  // CORE-2438 I7: inbound wakes render through the shared event module.
  registerEventRenderer(pi, INTERCOM_MESSAGE_TYPE, resolveIntercomCard);
}

/**
 * Map an injected intercom_message to its shared card details (exported
 * for the I7 end-to-end suite and for B3's task/monitor cards).
 */
export function resolveIntercomCard(message: unknown): EventDetails | null {
  const details = (message as { details?: unknown })?.details as
    | { messageId?: unknown; payloadRef?: unknown; from?: unknown; fromName?: unknown }
    | undefined;
  if (!details || typeof details !== "object") return null;
  const name =
    (typeof details.fromName === "string" && details.fromName) ||
    (typeof details.from === "string" && details.from) ||
    "unknown";
  const preview =
    typeof details.payloadRef === "string" && details.payloadRef ? details.payloadRef.split("\n") : [];
  return {
    kind: "message",
    state: "delivered",
    identity: `@${name}`,
    preview,
    facts: typeof details.messageId === "string" && details.messageId ? details.messageId : undefined,
    from: typeof details.from === "string" ? details.from : undefined,
    fromName: typeof details.fromName === "string" ? details.fromName : undefined,
    messageId: typeof details.messageId === "string" ? details.messageId : undefined,
  };
}
