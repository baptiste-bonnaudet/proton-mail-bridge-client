import type { EmailAction, ProtonRuntimeConfig } from "../types/index.js";

/**
 * Raised when the runtime policy denies an operation. The message is meant for
 * the caller (model or CLI user) and must explain how to proceed, so transport
 * layers should surface it verbatim instead of masking it as an internal error.
 */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export function sanitizeRuntimeConfig(runtime: ProtonRuntimeConfig): Record<string, unknown> {
  return {
    readOnly: runtime.readOnly,
    allowSend: runtime.allowSend,
    allowRemoteDraftSync: runtime.allowRemoteDraftSync,
    allowedActions: [...runtime.allowedActions],
    startupSync: runtime.startupSync,
    autoSyncFolder: runtime.autoSyncFolder,
    autoSyncFull: runtime.autoSyncFull,
    autoSyncLimitPerFolder: runtime.autoSyncLimitPerFolder,
    idleWatchEnabled: runtime.idleWatchEnabled,
    idleMaxSeconds: runtime.idleMaxSeconds,
    confirmDestructive: runtime.confirmDestructive,
    allowEmptyFolder: runtime.allowEmptyFolder,
    restrictOutboundToSelf: runtime.restrictOutboundToSelf,
    allowFileDownloadDir: runtime.allowFileDownloadDir ?? null,
    maxInlineBytes: runtime.maxInlineBytes,
    opDelayMs: runtime.opDelayMs,
  };
}

export function ensureSendAllowed(runtime: ProtonRuntimeConfig): void {
  if (!runtime.allowSend || runtime.readOnly) {
    throw new PolicyError("Send operations are disabled by the current runtime policy.");
  }
}

export function ensureEmailActionAllowed(
  runtime: ProtonRuntimeConfig,
  action: EmailAction,
): void {
  ensureMailboxWriteAllowed(runtime);

  if (!runtime.allowedActions.includes(action)) {
    throw new PolicyError(`Mailbox action ${action} is disabled by the current runtime policy.`);
  }
}

export function resolveRemoteDraftSync(
  runtime: ProtonRuntimeConfig,
  requested: boolean,
): {
  enabled: boolean;
  reason?: string;
} {
  if (!requested) {
    return { enabled: false };
  }

  if (runtime.readOnly) {
    return {
      enabled: false,
      reason: "Remote draft sync is disabled because the server is running in read-only mode.",
    };
  }

  if (!runtime.allowRemoteDraftSync) {
    return {
      enabled: false,
      reason: "Remote draft sync is disabled by the current runtime policy.",
    };
  }

  return { enabled: true };
}

export function ensureRemoteDraftSyncAllowed(runtime: ProtonRuntimeConfig): void {
  const decision = resolveRemoteDraftSync(runtime, true);
  if (!decision.enabled) {
    throw new PolicyError(decision.reason || "Remote draft sync is disabled by the current runtime policy.");
  }
}

export function ensureMailboxWriteAllowed(runtime: ProtonRuntimeConfig): void {
  if (runtime.readOnly) {
    throw new PolicyError("Mailbox write operations are disabled because the server is running in read-only mode.");
  }
}

export function ensureDestructiveConfirmed(
  runtime: ProtonRuntimeConfig,
  confirmed: boolean | undefined,
  description: string,
): void {
  if (!runtime.confirmDestructive) return;
  if (confirmed === true) return;
  throw new PolicyError(
    `Confirmation required: ${description}\n\nThis action is irreversible. Call this tool again with confirmed: true after asking the user to confirm.`,
  );
}
