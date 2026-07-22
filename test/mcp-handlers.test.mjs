import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

const OWNER = "owner@example.com";

function createConfig(dataDir, runtimeOverrides = {}) {
  return {
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: OWNER, password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: OWNER, password: "secret" },
    dataDir,
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {
      readOnly: false,
      allowSend: true,
      allowRemoteDraftSync: true,
      allowedActions: ["mark_read", "mark_unread", "star", "unstar", "archive", "trash", "restore", "move", "delete"],
      startupSync: false,
      autoSyncFolder: "INBOX",
      autoSyncFull: false,
      autoSyncLimitPerFolder: 100,
      idleWatchEnabled: false,
      idleMaxSeconds: 30,
      confirmDestructive: false,
      allowEmptyFolder: false,
      restrictOutboundToSelf: false,
      allowFileDownloadDir: undefined,
      maxInlineBytes: 40,
      opDelayMs: 0,
      ...runtimeOverrides,
    },
  };
}

/**
 * Boot the real MCP server over an in-memory transport. Tests stub methods
 * directly on the returned service instances; the tool handlers close over
 * the same objects, so no IMAP/SMTP connection is ever attempted.
 */
async function connectServer(runtimeOverrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "protonmail-mcp-test-"));
  const config = createConfig(dataDir, runtimeOverrides);
  const services = createServer(config, { startBackgroundSync: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handler-tests", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([services.server.connect(serverTransport), client.connect(clientTransport)]);

  const close = async () => {
    await client.close().catch(() => {});
    await services.server.close().catch(() => {});
    services.backgroundSyncService.stop();
    await rm(dataDir, { recursive: true, force: true });
  };

  return { client, services, close };
}

function stubSendPath(services) {
  const calls = [];
  services.smtpService.sendEmail = async (input) => {
    calls.push(input);
    return { messageId: "<sent@example.com>", accepted: input.to, rejected: [], response: "250 OK" };
  };
  services.imapService.resolveSentFolder = async () => "Sent";
  services.imapService.sentCopyVerify = async () => ({ found: true });
  return calls;
}

test("tool listing exposes the full surface including send_email", async () => {
  const { client, close } = await connectServer();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 50, `expected the full tool tier, got ${tools.length}`);
    assert.ok(tools.some((tool) => tool.name === "send_email"));
  } finally {
    await close();
  }
});

test("read-only mode rejects sends with the policy message, not an internal error", async () => {
  const { client, close } = await connectServer({ readOnly: true, allowSend: false });
  try {
    await assert.rejects(
      () => client.callTool({ name: "send_email", arguments: { to: OWNER, subject: "hi", body: "hi" } }),
      (error) => {
        assert.match(error.message, /disabled by the current runtime policy/i);
        assert.doesNotMatch(error.message, /internal error/i);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("confirmDestructive requires confirmed:true and tells the model how to proceed", async () => {
  const { client, services, close } = await connectServer({ confirmDestructive: true });
  try {
    await assert.rejects(
      () => client.callTool({ name: "delete_email", arguments: { emailId: "INBOX::42" } }),
      /Confirmation required[\s\S]*confirmed: true/i,
    );

    let deleted;
    services.imapService.deleteEmail = async (emailId) => {
      deleted = emailId;
      return { emailId, folder: "INBOX", uid: 42 };
    };
    const result = await client.callTool({
      name: "delete_email",
      arguments: { emailId: "INBOX::42", confirmed: true },
    });
    assert.equal(result.isError, undefined);
    assert.equal(deleted, "INBOX::42");
  } finally {
    await close();
  }
});

test("allowedActions blocks batch actions outside the allowlist", async () => {
  const { client, close } = await connectServer({ allowedActions: ["mark_read"] });
  try {
    await assert.rejects(
      () => client.callTool({ name: "batch_email_action", arguments: { emailIds: ["INBOX::1"], action: "trash" } }),
      /disabled by the current runtime policy/i,
    );
  } finally {
    await close();
  }
});

test("restrictOutboundToSelf blocks external recipients and allows self", async () => {
  const { client, services, close } = await connectServer({ restrictOutboundToSelf: true });
  try {
    await assert.rejects(
      () => client.callTool({ name: "send_email", arguments: { to: "evil@example.net", subject: "s", body: "b" } }),
      /RESTRICT_OUTBOUND_TO_SELF/,
    );

    const calls = stubSendPath(services);
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: OWNER, subject: "note to self", body: "b" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].to, [OWNER]);
  } finally {
    await close();
  }
});

test("invalid recipients are rejected with the validation message", async () => {
  const { client, close } = await connectServer();
  try {
    await assert.rejects(
      () => client.callTool({ name: "send_email", arguments: { to: "not-an-email", subject: "s", body: "b" } }),
      /Invalid to email address/i,
    );
  } finally {
    await close();
  }
});

test("malformed emailId surfaces the validation message from the service layer", async () => {
  const { client, close } = await connectServer();
  try {
    // deleteEmail is intentionally NOT stubbed: parseEmailId rejects before
    // any IMAP connection is attempted.
    await assert.rejects(
      () => client.callTool({ name: "delete_email", arguments: { emailId: "garbage", confirmed: true } }),
      /Invalid emailId/i,
    );
  } finally {
    await close();
  }
});

test("unexpected service errors stay generic and do not leak details", async () => {
  const { client, services, close } = await connectServer();
  try {
    services.smtpService.sendEmail = async () => {
      throw new Error("SMTP boom with sensitive internals");
    };
    await assert.rejects(
      () => client.callTool({ name: "send_email", arguments: { to: OWNER, subject: "s", body: "b" } }),
      (error) => {
        assert.match(error.message, /internal error/i);
        assert.doesNotMatch(error.message, /boom/);
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("dryRun previews the send without calling SMTP", async () => {
  const { client, services, close } = await connectServer();
  try {
    const calls = stubSendPath(services);
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: OWNER, subject: "s", body: "b", dryRun: true },
    });
    assert.equal(result.structuredContent.dryRun, true);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("successful sends are audited with the body redacted", async () => {
  const { client, services, close } = await connectServer();
  try {
    stubSendPath(services);
    const entries = [];
    services.auditService.record = async (entry) => {
      entries.push(entry);
    };

    await client.callTool({
      name: "send_email",
      arguments: { to: OWNER, subject: "quarterly numbers", body: "super secret contents" },
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, "send_email");
    assert.equal(entries[0].status, "success");
    assert.equal(entries[0].input.body, "[redacted]");
    assert.equal(entries[0].input.to, OWNER);
  } finally {
    await close();
  }
});
