import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { SMTPService, sanitizeHeader } from "../dist/services/smtp-service.js";

const OWNER = "owner@example.com";

function createService() {
  return new SMTPService({
    smtp: { host: "127.0.0.1", port: 1025, secure: false, username: OWNER, password: "secret" },
    imap: { host: "127.0.0.1", port: 1143, secure: false, username: OWNER, password: "secret" },
    dataDir: "/tmp/unused",
    debug: false,
    cacheEnabled: true,
    analyticsEnabled: true,
    autoSync: false,
    syncInterval: 5,
    runtime: {},
  });
}

test("sanitizeHeader replaces CR and LF with spaces", () => {
  assert.equal(sanitizeHeader("hello\r\nBcc: evil"), "hello  Bcc: evil");
});

test("sanitizeHeader leaves normal headers unchanged", () => {
  assert.equal(sanitizeHeader("normal subject"), "normal subject");
});

test("CRLF in subject, fromName, and replyTo cannot inject headers", async () => {
  const raw = await createService().buildRawMessage({
    to: ["dest@example.com"],
    subject: "Invoice\r\nBcc: evil@example.net",
    body: "hello",
    fromName: 'Alice\r\nX-Evil: 1 "quoted"',
    replyTo: "reply@example.com\r\nX-Sneak: 1",
  });

  const parsed = await simpleParser(raw);
  assert.equal(parsed.subject, "Invoice  Bcc: evil@example.net");
  assert.equal(parsed.bcc, undefined);
  assert.equal(parsed.headers.get("x-evil"), undefined);
  assert.equal(parsed.headers.get("x-sneak"), undefined);
  assert.equal(parsed.from.value[0].address, OWNER);
});

test("HTML bodies are sanitized: scripts, handlers, and javascript: hrefs stripped", async () => {
  const raw = await createService().buildRawMessage({
    to: ["dest@example.com"],
    subject: "s",
    body: '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">c</a><a href="https://ok.example">ok</a>',
    isHtml: true,
  });

  const parsed = await simpleParser(raw);
  assert.ok(parsed.html.includes("Hi"));
  assert.ok(!parsed.html.includes("<script"));
  assert.ok(!parsed.html.includes("onclick"));
  assert.ok(!parsed.html.includes("javascript:"));
  assert.ok(parsed.html.includes('href="https://ok.example"'));
});

test("sanitizeHtml:false is suppressed unless PROTONMAIL_ALLOW_UNSAFE_HTML is set", async () => {
  const previous = process.env.PROTONMAIL_ALLOW_UNSAFE_HTML;
  delete process.env.PROTONMAIL_ALLOW_UNSAFE_HTML;
  try {
    const raw = await createService().buildRawMessage({
      to: ["dest@example.com"],
      subject: "s",
      body: "<p>Hi</p><script>alert(1)</script>",
      isHtml: true,
      sanitizeHtml: false,
    });
    const parsed = await simpleParser(raw);
    assert.ok(!parsed.html.includes("<script"), "opt-out must not bypass sanitization without the env gate");
  } finally {
    if (previous !== undefined) process.env.PROTONMAIL_ALLOW_UNSAFE_HTML = previous;
  }
});

test("multipart alternative keeps the plain-text fallback alongside HTML", async () => {
  const raw = await createService().buildRawMessage({
    to: ["dest@example.com"],
    subject: "s",
    body: "plain fallback",
    htmlBody: "<p>rich</p>",
  });

  const parsed = await simpleParser(raw);
  assert.equal(parsed.text.trim(), "plain fallback");
  assert.ok(parsed.html.includes("<p>rich</p>"));
});

test("attachments decode from base64 with content type", async () => {
  const content = Buffer.from("attachment bytes");
  const raw = await createService().buildRawMessage({
    to: ["dest@example.com"],
    subject: "s",
    body: "b",
    attachments: [
      {
        filename: "notes.txt",
        content: content.toString("base64"),
        contentType: "text/plain",
        contentDisposition: "attachment",
      },
    ],
  });

  const parsed = await simpleParser(raw);
  assert.equal(parsed.attachments.length, 1);
  const attachment = parsed.attachments[0];
  assert.equal(attachment.filename, "notes.txt");
  assert.equal(attachment.content.toString("utf8"), "attachment bytes");
  assert.equal(attachment.contentDisposition, "attachment");
});

test("inline cid attachments ride along with an HTML body", async () => {
  const raw = await createService().buildRawMessage({
    to: ["dest@example.com"],
    subject: "s",
    body: "b",
    htmlBody: '<p>logo: <img src="cid:logo-1"></p>',
    attachments: [
      {
        filename: "logo.png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        contentType: "image/png",
        cid: "logo-1",
        contentDisposition: "inline",
      },
    ],
  });

  const parsed = await simpleParser(raw);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].contentId, "<logo-1>");
});

test("threading headers survive into the raw message", async () => {
  const raw = await createService().buildRawMessage({
    to: ["dest@example.com"],
    subject: "s",
    body: "b",
    inReplyTo: "<parent@example.com>",
    references: ["<root@example.com>", "<parent@example.com>"],
    messageId: "<self@example.com>",
  });

  const parsed = await simpleParser(raw);
  assert.equal(parsed.inReplyTo, "<parent@example.com>");
  assert.deepEqual(parsed.references, ["<root@example.com>", "<parent@example.com>"]);
  assert.equal(parsed.messageId, "<self@example.com>");
});
