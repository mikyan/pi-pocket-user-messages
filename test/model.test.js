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
    assert.equal(await store.syncLatest(), false);
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

test("latest sync prepends new messages while retaining older pages and their cursor", async () => {
    const pages = [page([4, 5], "older"), page([2, 3], "oldest"), page([5, 6], "head"), page([1])];
    const pocket = host(() => pages.shift());
    const store = createMessageStore(pocket, { pageSize: 2 });
    await store.start();
    await store.loadMore();
    const previousRows = store.getSnapshot().messages;
    await store.syncLatest();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["6", "5", "4", "3", "2"]);
    assert.equal(store.getSnapshot().before, "oldest");
    assert.equal(store.getSnapshot().messages[1], previousRows[0]);
    assert.equal(store.getSnapshot().loading, false);
    assert.equal(pocket.requests[2].before, null);
    await store.loadMore();
    assert.equal(pocket.requests[3].before, "oldest");
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["6", "5", "4", "3", "2", "1"]);
    store.dispose();
});

test("unchanged latest sync and transient errors leave the exact snapshot untouched", async () => {
    const pocket = host((_options, call) => {
        if (call === 3) {
            throw new Error("Offline");
        }

        return call === 4 ? page([99], null, 999) : page([1, 2], "older");
    });
    const store = createMessageStore(pocket);
    await store.start();
    const snapshot = store.getSnapshot();
    let notifications = 0;
    store.subscribe(() => notifications += 1);
    assert.equal(await store.syncLatest(), true);
    assert.equal(await store.syncLatest(), false);
    assert.equal(await store.syncLatest(), false);
    assert.equal(store.getSnapshot(), snapshot);
    assert.equal(notifications, 1);
    store.dispose();
});

test("latest sync deduplicates rows and updates changed message metadata in place", async () => {
    const updated = { ...message(2), by: { id: "writer", name: "Renamed author" }, at: 123 };
    const pocket = host((_options, call) => call === 1 ? page([1, 2]) : {
        ...page([]), messages: [message(1), updated, updated, message(3)],
    });
    const store = createMessageStore(pocket);
    await store.start();
    const unchanged = store.getSnapshot().messages[1];
    await store.syncLatest();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["3", "2", "1"]);
    assert.equal(store.getSnapshot().messages[1].by.name, "Renamed author");
    assert.equal(store.getSnapshot().messages[2], unchanged);
    store.dispose();
});

test("sync skips busy reads and concurrent syncs; manual pagination aborts a pending sync", async () => {
    const initial = deferred();
    const latest = deferred();
    const older = deferred();
    const pocket = host((_options, call) => [initial.promise, latest.promise, older.promise][call - 1]);
    const store = createMessageStore(pocket);
    const starting = store.start();
    assert.equal(await store.syncLatest(), false);
    initial.resolve(page([3], "older"));
    await starting;
    const snapshot = store.getSnapshot();
    const syncing = store.syncLatest();
    assert.equal(store.getSnapshot(), snapshot);
    assert.equal(await store.syncLatest(), false);
    const loading = store.loadMore();
    assert.equal(pocket.requests[1].signal.aborted, true);
    assert.equal(await store.syncLatest(), false);
    assert.equal(pocket.requests.length, 3);
    older.resolve(page([2], "oldest"));
    await loading;
    latest.resolve(page([99]));
    assert.equal(await syncing, false);
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["3", "2"]);
    store.dispose();
});

for (const action of ["refresh", "session switch", "dispose"]) {
    test(`${action} aborts latest sync and discards its late response`, async () => {
        const pending = deferred();
        const pocket = host((_options, call) => {
            if (call === 1) {
                return page([1]);
            }

            return call === 2 ? pending.promise : page([20], null, action === "session switch" ? 2 : 1);
        });
        const store = createMessageStore(pocket);
        await store.start();
        const syncing = store.syncLatest();
        await settle();

        if (action === "refresh") {
            await store.refresh();
        } else if (action === "session switch") {
            pocket.switchTo(2);
            await settle();
        } else {
            store.dispose();
        }

        assert.equal(pocket.requests[1].signal.aborted, true);
        const snapshot = store.getSnapshot();
        pending.resolve(page([99]));
        assert.equal(await syncing, false);
        assert.equal(store.getSnapshot(), snapshot);
        assert.deepEqual(snapshot.messages.map((item) => item.id), action === "dispose" ? [] : ["20"]);
        store.dispose();
    });
}

test("latest sync replaces a disconnected history window and resets pagination", async () => {
    const pages = [page([3, 4], "older"), page([1, 2], "oldest"), page([8, 9], "new-older"), page([6, 7], "older")];
    const pocket = host(() => pages.shift());
    const store = createMessageStore(pocket, { pageSize: 2 });
    await store.start();
    await store.loadMore();
    await store.syncLatest();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["9", "8"]);
    assert.equal(store.getSnapshot().before, "new-older");
    assert.match(store.getSnapshot().notice, /newest messages/i);
    await store.loadMore();
    assert.equal(pocket.requests[3].before, "new-older");
    assert.equal(store.getSnapshot().error, null);
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["9", "8", "7", "6"]);
    store.dispose();
});

test("a complete latest page removes old context rows, including an empty reset", async () => {
    const pages = [page([2, 3], "older"), page([1]), page([3]), page([]), page([]), page([4])];
    const pocket = host(() => pages.shift());
    const store = createMessageStore(pocket, { pageSize: 2 });
    await store.start();
    await store.loadMore();
    await store.syncLatest();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["3"]);
    assert.equal(store.getSnapshot().before, null);
    await store.syncLatest();
    assert.deepEqual(store.getSnapshot().messages, []);
    const empty = store.getSnapshot();
    await store.syncLatest();
    assert.equal(store.getSnapshot(), empty);
    await store.syncLatest();
    assert.deepEqual(store.getSnapshot().messages.map((item) => item.id), ["4"]);
    store.dispose();
});
