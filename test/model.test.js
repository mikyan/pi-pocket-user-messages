import assert from "node:assert/strict";
import test from "node:test";
import { createMessageStore, filterMessages, previewText } from "../user-messages/model.js";

const message = (id, text = `Message ${id}`) => ({
    id: String(id),
    text,
    clipped: false,
    by: { id: null, name: null },
    at: null,
});
const page = (ids, before = null, conversationId = 1) => ({
    conversationId,
    messages: ids.map((id) => message(id)),
    before,
});
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

function host(respond, initialSession = 1) {
    let listener;
    let conversationId = initialSession;
    let unsubscribed = 0;
    const requests = [];

    return {
        requests,
        get unsubscribed() {
            return unsubscribed;
        },
        conversationId: () => conversationId,
        onConversation(callback) {
            listener = callback;
            callback(conversationId);

            return () => {
                listener = null;
                unsubscribed += 1;
            };
        },
        messages(options) {
            requests.push(options);

            return Promise.resolve().then(() => respond(options, requests.length));
        },
        switchTo(id) {
            conversationId = id;
            listener?.(id);
        },
    };
}

test("pages newest first and deduplicates overlapping history by ID", async () => {
    const pocket = host(({ before }) => before === null ? page([3, 4], "older") : page([1, 2, 3]));
    const store = createMessageStore(pocket, { pageSize: 2 });
    const observed = [];
    const unsubscribe = store.subscribe((state) => observed.push(state));

    assert.equal(observed.length, 1);
    await store.start();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["4", "3"]);
    await store.loadMore();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["4", "3", "2", "1"]);
    assert.equal(store.getSnapshot().before, null);
    assert.equal(await store.loadMore(), false);
    assert.equal(pocket.requests.length, 2);
    assert.equal(pocket.requests[0].limit, 2);
    assert.equal(pocket.requests[1].before, "older");
    unsubscribe();
    store.dispose();
});

test("session switches clear old rows immediately and discard late responses", async () => {
    const oldRead = deferred();
    const newRead = deferred();
    const pocket = host((_options, call) => call === 1 ? oldRead.promise : newRead.promise);
    const store = createMessageStore(pocket);
    const starting = store.start();
    await settle();
    pocket.switchTo(2);
    assert.equal(store.getSnapshot().conversationId, 2);
    assert.deepEqual(store.getSnapshot().messages, []);
    assert.equal(pocket.requests[0].signal.aborted, true);
    await settle();
    newRead.resolve(page([20], null, 2));
    await settle();
    oldRead.resolve(page([10]));
    await starting;
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["20"]);
    pocket.switchTo(null);
    assert.deepEqual(store.getSnapshot().messages, []);
    assert.equal(store.getSnapshot().conversationId, null);
    store.dispose();
});

test("refresh aborts an older-page request and ignores its eventual completion", async () => {
    const oldRead = deferred();
    const pocket = host((_options, call) => {
        if (call === 1) {
            return page([2], "older");
        }

        return call === 2 ? oldRead.promise : page([9]);
    });
    const store = createMessageStore(pocket);
    await store.start();
    const loading = store.loadMore();
    await settle();
    await store.refresh();
    assert.equal(pocket.requests[1].signal.aborted, true);
    oldRead.resolve(page([1]));
    await loading;
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["9"]);
    store.dispose();
});

test("a stale cursor reloads newest history once and informs the reader", async () => {
    const pocket = host((_options, call) => {
        if (call === 1) {
            return page([2], "stale");
        }

        if (call === 2) {
            throw Object.assign(new Error("Cursor is stale"), { status: 409 });
        }

        return page([7, 8], "replacement");
    });
    const store = createMessageStore(pocket);
    await store.start();
    await store.loadAll();
    assert.equal(pocket.requests.length, 3);
    assert.equal(pocket.requests[2].before, null);
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["8", "7"]);
    assert.match(store.getSnapshot().notice, /history changed/i);
    assert.equal(store.getSnapshot().loadingAll, false);
    assert.equal(store.getSnapshot().error, null);
    store.dispose();
});

test("a failing stale-cursor recovery does not recursively retry", async () => {
    const pocket = host((_options, call) => {
        if (call === 1) {
            return page([2], "stale");
        }

        throw Object.assign(new Error("Still stale"), { status: 409 });
    });
    const store = createMessageStore(pocket);
    await store.start();
    await store.loadMore();
    assert.equal(pocket.requests.length, 3);
    assert.deepEqual(store.getSnapshot().messages, []);
    assert.equal(store.getSnapshot().error, "Still stale");
    assert.equal(store.getSnapshot().loading, false);
    store.dispose();
});

test("ordinary failures retain loaded messages and allow retrying the same cursor", async () => {
    const pocket = host((_options, call) => {
        if (call === 1) {
            return page([2], "older");
        }

        if (call === 2) {
            throw new Error("Offline");
        }

        return page([1]);
    });
    const store = createMessageStore(pocket);
    await store.start();
    await store.loadMore();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["2"]);
    assert.equal(store.getSnapshot().before, "older");
    assert.equal(store.getSnapshot().error, "Offline");
    await store.loadMore();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["2", "1"]);
    assert.equal(store.getSnapshot().error, null);
    store.dispose();
});

test("loadAll reads to the beginning and can be cancelled without losing loaded rows", async () => {
    const interrupted = deferred();
    const pocket = host(({ before }, call) => {
        if (call === 2) {
            return interrupted.promise;
        }

        if (before === null) {
            return page([3], "middle");
        }

        return before === "middle" ? page([2], "first") : page([1]);
    });
    const store = createMessageStore(pocket);
    await store.start();
    const all = store.loadAll();
    await settle();
    store.cancelLoadAll();
    assert.equal(pocket.requests[1].signal.aborted, true);
    assert.equal(store.getSnapshot().loadingAll, false);
    assert.equal(store.getSnapshot().loading, false);
    interrupted.resolve(page([99]));
    await all;
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["3"]);
    await store.loadAll();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["3", "2", "1"]);
    assert.equal(store.getSnapshot().before, null);
    assert.equal(store.getSnapshot().loadingAll, false);
    store.dispose();
});

test("a repeated cursor stops full-history loading instead of looping", async () => {
    const pocket = host(() => page([1], "same"));
    const store = createMessageStore(pocket);
    await store.start();
    await store.loadAll();
    assert.equal(pocket.requests.length, 2);
    assert.match(store.getSnapshot().error, /repeated.*cursor/i);
    assert.equal(store.getSnapshot().loadingAll, false);
    store.dispose();
});

test("dispose stops observing sessions, aborts reads, and removes message data", async () => {
    const pending = deferred();
    const pocket = host(() => pending.promise);
    const store = createMessageStore(pocket);
    let notifications = 0;
    store.subscribe(() => notifications += 1);
    const starting = store.start();
    await settle();
    store.dispose();
    store.dispose();
    const afterDisposal = notifications;
    assert.equal(pocket.unsubscribed, 1);
    assert.equal(pocket.requests[0].signal.aborted, true);
    pending.resolve(page([1]));
    await starting;
    pocket.switchTo(2);
    assert.equal(notifications, afterDisposal);
    assert.deepEqual(store.getSnapshot().messages, []);
    assert.equal(store.getSnapshot().conversationId, null);
    assert.equal(await store.refresh(), false);
    assert.equal(await store.loadMore(), false);
});

test("no open session makes no read; mismatched pages are never displayed", async () => {
    const pocket = host(() => page([1], null, 999), null);
    const store = createMessageStore(pocket);
    await store.start();
    await store.loadAll();
    assert.equal(pocket.requests.length, 0);
    pocket.switchTo(1);
    await settle();
    assert.deepEqual(store.getSnapshot().messages, []);
    assert.match(store.getSnapshot().error, /session changed/i);
    store.dispose();
});

test("previews collapse whitespace, respect clipping, and do not split Unicode code points", () => {
    assert.equal(previewText(message(1, "  Hello\n\t world  ")), "Hello world");
    assert.equal(previewText(message(1, "😀😀😀"), 2), "😀…");
    assert.equal(previewText({ ...message(1, "partial"), clipped: true }), "partial…");
    assert.equal(previewText(message(1, "")), "Attachment or empty message");
    assert.equal(previewText(message(1, "<script>alert(1)</script>")), "<script>alert(1)</script>");
    assert.throws(() => previewText(message(1), 0), RangeError);
});

test("filtering matches all words across message text and author, including Chinese", () => {
    const rows = [
        { ...message(1, "PAYMENT 支付模块"), by: { name: "Alice", id: "p1" } },
        { ...message(2, "Payment reconciliation"), by: { name: "Bob", id: "p2" } },
    ];

    assert.deepEqual(filterMessages(rows, "alice 支付").map((item) => item.id), ["1"]);
    assert.deepEqual(filterMessages(rows, "payment  BOB").map((item) => item.id), ["2"]);
    assert.deepEqual(filterMessages(rows, "ＰＡＹＭＥＮＴ p1").map((item) => item.id), ["1"]);
    assert.deepEqual(filterMessages(rows, "missing"), []);
    assert.equal(filterMessages(rows, "  "), rows);
});

test("page size rejects values outside Pocket's supported range", () => {
    assert.throws(() => createMessageStore({}, { pageSize: 201 }), RangeError);
    assert.throws(() => createMessageStore({}, { pageSize: 0 }), RangeError);
    assert.throws(() => createMessageStore({}, { pageSize: 1.5 }), RangeError);
});
