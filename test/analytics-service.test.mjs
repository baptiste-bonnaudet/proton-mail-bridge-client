import test from "node:test";
import assert from "node:assert/strict";
import { AnalyticsService } from "../dist/services/analytics-service.js";

const OWNER = "owner@example.com";
const TODAY = new Date().toISOString();

let nextUid = 1;
function mkEmail(overrides = {}) {
  const uid = nextUid++;
  return {
    id: `INBOX::${uid}`,
    folder: "INBOX",
    uid,
    seq: uid,
    messageId: `<m${uid}@example.com>`,
    subject: "s",
    from: [{ address: "alice@acme.com", name: "Alice" }],
    to: [{ address: OWNER }],
    cc: [],
    bcc: [],
    replyTo: [],
    labels: [],
    flags: [],
    attachments: [],
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    date: TODAY,
    internalDate: TODAY,
    ...overrides,
  };
}

test("getEmailStats aggregates folder counts and dedupes the sample", () => {
  const service = new AnalyticsService();
  const shared = { messageId: "<dup@example.com>" };
  const stats = service.getEmailStats(
    [mkEmail(shared), mkEmail(shared), mkEmail({ isStarred: true, hasAttachments: true })],
    [
      { path: "INBOX", name: "INBOX", delimiter: "/", listed: true, subscribed: true, flags: [], messages: 10, unseen: 3 },
      { path: "Archive", name: "Archive", delimiter: "/", listed: true, subscribed: true, flags: [], messages: 5, unseen: 0 },
    ],
    OWNER,
  );

  assert.equal(stats.mailbox.folderCount, 2);
  assert.equal(stats.mailbox.totalMessages, 15);
  assert.equal(stats.mailbox.unreadMessages, 3);
  assert.equal(stats.sample.size, 2, "duplicate messageIds collapse");
  assert.equal(stats.sample.starredMessages, 1);
  assert.equal(stats.sample.messagesWithAttachments, 1);
  assert.equal(stats.sample.uniqueContacts, 1, "owner is not a contact");
});

test("getEmailAnalytics ranks senders and domains excluding the owner", () => {
  const service = new AnalyticsService();
  const emails = [
    mkEmail({ from: [{ address: "alice@acme.com" }] }),
    mkEmail({ from: [{ address: "alice@acme.com" }] }),
    mkEmail({ from: [{ address: "bob@other.net" }] }),
    mkEmail({ from: [{ address: OWNER }], to: [{ address: "alice@acme.com" }] }),
  ];

  const analytics = service.getEmailAnalytics(emails, OWNER);
  assert.equal(analytics.sampleSize, 4);
  assert.deepEqual(analytics.topSenders[0], { address: "alice@acme.com", count: 2 });
  assert.ok(!analytics.topSenders.some((sender) => sender.address === OWNER));
  assert.deepEqual(analytics.topDomains[0], { domain: "acme.com", count: 2 });
  assert.equal(analytics.insights.length, 3);
  assert.match(analytics.insights[1], /alice@acme\.com/);
});

test("getContacts classifies direction and respects the limit", () => {
  const service = new AnalyticsService();
  const emails = [
    mkEmail({ from: [{ address: "alice@acme.com" }] }),
    mkEmail({ from: [{ address: "alice@acme.com" }] }),
    mkEmail({ from: [{ address: OWNER }], to: [{ address: "alice@acme.com" }] }),
    mkEmail({ from: [{ address: "bob@other.net" }] }),
  ];

  const contacts = service.getContacts(emails, 10, OWNER);
  const alice = contacts.find((contact) => contact.address === "alice@acme.com");
  assert.equal(alice.incoming, 2);
  assert.equal(alice.outgoing, 1);
  assert.equal(alice.totalMessages, 3);
  assert.equal(contacts[0].address, "alice@acme.com", "sorted by volume");
  assert.ok(!contacts.some((contact) => contact.address === OWNER));
  assert.equal(service.getContacts(emails, 1, OWNER).length, 1);
});

test("getVolumeTrends buckets today's messages with flag counts", () => {
  const service = new AnalyticsService();
  const trends = service.getVolumeTrends(
    [
      mkEmail({ isRead: false, isStarred: true, hasAttachments: true }),
      mkEmail({}),
      mkEmail({ date: "2001-01-01T00:00:00Z", internalDate: "2001-01-01T00:00:00Z" }),
    ],
    7,
  );

  assert.equal(trends.length, 7);
  const today = trends[trends.length - 1];
  assert.equal(today.date, TODAY.slice(0, 10));
  assert.equal(today.count, 2, "out-of-window messages are ignored");
  assert.equal(today.unreadCount, 1);
  assert.equal(today.starredCount, 1);
  assert.equal(today.attachmentCount, 1);
});
