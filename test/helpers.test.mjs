import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAttachment,
  createEmailId,
  dedupeEmails,
  extractDomain,
  extractMessageIdList,
  isTextLikeMimeType,
  isValidEmail,
  lowerCaseAddress,
  matchesLocalSearchFilters,
  normalizeLimit,
  normalizeMailboxLabel,
  normalizeMessageId,
  normalizeSubjectForThread,
  nextDay,
  parseDateInput,
  parseEmailId,
  parseEmails,
  previewText,
  renderMarkdown,
  sanitizeFileName,
  sortEmailsByNewest,
  stringifyForJson,
  stripHtmlToText,
  summarizeCalendarText,
} from "../dist/utils/helpers.js";

test("parseEmails splits on commas and semicolons and trims", () => {
  assert.deepEqual(parseEmails("a@x.com, b@x.com; c@x.com ,"), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.deepEqual(parseEmails(undefined), []);
});

test("isValidEmail rejects header-injection shaped addresses", () => {
  assert.equal(isValidEmail("a@x.com"), true);
  assert.equal(isValidEmail("a@x.com\r\nBcc: evil@x.com"), false);
  assert.equal(isValidEmail("not an email"), false);
});

test("emailId round-trips folders containing the separator and slashes", () => {
  const id = createEmailId("Labels/Q4::review", 42);
  assert.deepEqual(parseEmailId(id), { folder: "Labels/Q4::review", uid: 42 });
});

test("previewText collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(previewText("  a   b\n\tc  "), "a b c");
  const long = previewText("x".repeat(500));
  assert.ok(long.endsWith("..."));
  assert.ok(long.length <= 223);
  assert.equal(previewText("   "), undefined);
});

test("stripHtmlToText drops style/script blocks and decodes entities", () => {
  const text = stripHtmlToText("<style>p{}</style><p>Hello&nbsp;&amp;<script>bad()</script> World</p>");
  assert.ok(text.includes("Hello &"));
  assert.ok(text.includes("World"));
  assert.ok(!text.includes("bad()"));
});

test("extractMessageIdList normalizes case and dedupes", () => {
  assert.deepEqual(extractMessageIdList("<A@B.com> stray <a@b.com>"), ["<a@b.com>"]);
  assert.deepEqual(extractMessageIdList(["<x@y.com>", "<z@y.com>"]), ["<x@y.com>", "<z@y.com>"]);
});

test("dedupeEmails keys on messageId then falls back to id", () => {
  const emails = [
    { id: "INBOX::1", messageId: "<m@x>" },
    { id: "Archive::9", messageId: "<m@x>" },
    { id: "INBOX::2", messageId: undefined },
  ];
  assert.deepEqual(dedupeEmails(emails).map((e) => e.id), ["INBOX::1", "INBOX::2"]);
});

test("sortEmailsByNewest breaks date ties with the higher uid", () => {
  const sorted = sortEmailsByNewest([
    { uid: 1, date: "2026-01-01T00:00:00Z" },
    { uid: 3, date: "2026-01-01T00:00:00Z" },
    { uid: 2, date: "2026-02-01T00:00:00Z" },
  ]);
  assert.deepEqual(sorted.map((e) => e.uid), [2, 3, 1]);
});

test("normalizeLimit clamps, truncates, and falls back on junk", () => {
  assert.equal(normalizeLimit(5.9, 10), 5);
  assert.equal(normalizeLimit(0, 10), 1);
  assert.equal(normalizeLimit(9999, 10), 250);
  assert.equal(normalizeLimit("nope", 10), 10);
  assert.equal(normalizeLimit(undefined, 10), 10);
});

test("parseDateInput rejects invalid dates and nextDay adds 24h", () => {
  assert.throws(() => parseDateInput("not-a-date"), /Invalid date value/);
  assert.equal(parseDateInput(undefined), undefined);
  const day = parseDateInput("2026-03-01T00:00:00Z");
  assert.equal(nextDay(day).toISOString(), "2026-03-02T00:00:00.000Z");
});

test("matchesLocalSearchFilters applies attachment, label, domain, and role filters", () => {
  const email = {
    folder: "INBOX",
    labels: ["Labels/Work"],
    hasAttachments: true,
    attachments: [{ filename: "Report-Q4.pdf" }],
    from: [{ address: "alice@acme.com" }],
    threadId: "t1",
  };
  assert.equal(matchesLocalSearchFilters(email, { hasAttachment: true }), true);
  assert.equal(matchesLocalSearchFilters(email, { hasAttachment: false }), false);
  assert.equal(matchesLocalSearchFilters(email, { threadId: "t1" }), true);
  assert.equal(matchesLocalSearchFilters(email, { threadId: "other" }), false);
  assert.equal(matchesLocalSearchFilters(email, { attachmentName: "report-q4" }), true);
  assert.equal(matchesLocalSearchFilters(email, { attachmentName: "missing" }), false);
  assert.equal(matchesLocalSearchFilters(email, { senderDomain: "acme.com" }), true);
  assert.equal(matchesLocalSearchFilters(email, { senderDomain: "other.com" }), false);
  assert.equal(matchesLocalSearchFilters(email, { mailboxRole: "inbox" }), true);
  assert.equal(matchesLocalSearchFilters(email, { mailboxRole: "trash" }), false);
});

test("stringifyForJson normalizes buffers, dates, maps, sets, and bigints", () => {
  const parsed = JSON.parse(
    stringifyForJson({
      buf: Buffer.from("hi"),
      when: new Date("2026-01-01T00:00:00Z"),
      map: new Map([["k", 1]]),
      set: new Set([1, 2]),
      big: 10n,
      gone: undefined,
    }),
  );
  assert.equal(parsed.buf, Buffer.from("hi").toString("base64"));
  assert.equal(parsed.when, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(parsed.map, { k: 1 });
  assert.deepEqual(parsed.set, [1, 2]);
  assert.equal(parsed.big, "10");
  assert.ok(!("gone" in parsed));
});

test("address and message-id normalization", () => {
  assert.equal(lowerCaseAddress("  Alice@Example.COM "), "alice@example.com");
  assert.equal(normalizeMessageId(" <A B@x.com> "), "<ab@x.com>");
  assert.equal(extractDomain("a@Example.com"), "example.com");
  assert.equal(extractDomain("no-at-sign"), undefined);
});

test("normalizeSubjectForThread strips stacked reply/forward prefixes", () => {
  assert.equal(normalizeSubjectForThread("Re: RE: Fwd: Budget"), "Budget");
  assert.equal(normalizeSubjectForThread("   "), "(no subject)");
  assert.equal(normalizeSubjectForThread("Re:"), "(no subject)");
});

test("sanitizeFileName neutralizes separators and traversal sequences", () => {
  const traversal = sanitizeFileName("../../etc/passwd");
  assert.ok(!traversal.includes("/"));
  assert.ok(!traversal.includes(".."));
  const windows = sanitizeFileName('con:file*na?me".pdf');
  assert.ok(!/[:*?"]/.test(windows));
  assert.equal(sanitizeFileName(undefined), "attachment");
  assert.equal(sanitizeFileName("", "fallback"), "fallback");
  assert.equal(sanitizeFileName("///"), "_", "separators collapse to a safe placeholder");
});

test("classifyAttachment covers the documented kinds", () => {
  assert.equal(classifyAttachment({ filename: "invite.ics" }).kind, "calendar");
  assert.equal(classifyAttachment({ filename: "smime.p7s" }).kind, "signature");
  assert.equal(classifyAttachment({ contentType: "image/png" }).kind, "image");
  assert.equal(classifyAttachment({ filename: "old.eml" }).kind, "message");
  assert.equal(classifyAttachment({ filename: "backup.zip" }).kind, "archive");
  assert.equal(classifyAttachment({ contentType: "text/plain" }).kind, "text");
  assert.equal(classifyAttachment({ filename: "report.pdf" }).kind, "document");
  assert.equal(classifyAttachment({ disposition: "inline" }).kind, "image");
  assert.equal(classifyAttachment({}).kind, "other");
});

test("isTextLikeMimeType recognizes text-adjacent types", () => {
  assert.equal(isTextLikeMimeType("text/html"), true);
  assert.equal(isTextLikeMimeType("application/json"), true);
  assert.equal(isTextLikeMimeType("application/pdf"), false);
  assert.equal(isTextLikeMimeType(undefined), false);
});

test("summarizeCalendarText pulls the headline fields", () => {
  const summary = summarizeCalendarText(
    "BEGIN:VEVENT\r\nSUMMARY:Standup\r\nDTSTART;TZID=America/Montreal:20260401T100000\r\nLOCATION:Room 1\r\nEND:VEVENT",
  );
  assert.ok(summary.includes("Standup"));
  assert.ok(summary.includes("Starts"));
  assert.ok(summary.includes("Location Room 1"));
});

test("normalizeMailboxLabel maps aliases and strips the Labels prefix", () => {
  assert.equal(normalizeMailboxLabel("junk"), "Spam");
  assert.equal(normalizeMailboxLabel("sent mail"), "Sent");
  assert.equal(normalizeMailboxLabel("deleted messages"), "Trash");
  assert.equal(normalizeMailboxLabel("Labels/Clients"), "Clients");
  assert.equal(normalizeMailboxLabel(undefined), undefined);
});

test("renderMarkdown produces safe HTML", () => {
  const { html, text } = renderMarkdown(
    [
      "# Title",
      "",
      "Some **bold** and `inline` text.",
      "",
      "- item one",
      "- item two",
      "",
      "> quoted",
      "",
      "```",
      "<script>alert(1)</script>",
      "```",
      "",
      "[ok](https://example.com) [bad](javascript:alert(1))",
    ].join("\n"),
  );

  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>inline</code>"));
  assert.ok(html.includes("<ul>") && html.includes("<li>item one</li>"));
  assert.ok(html.includes("<blockquote>quoted</blockquote>"));
  assert.ok(html.includes("&lt;script&gt;"), "code fences must escape HTML");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('<a href="https://example.com">ok</a>'));
  assert.ok(html.includes('<a href="#">bad</a>'), "javascript: links must be neutralized");
  assert.ok(text.includes("# Title"), "plain-text fallback keeps the original markdown");
});
