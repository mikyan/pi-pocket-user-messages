import test from "node:test";
import assert from "node:assert/strict";
import server from "../user-messages.ts";
import setup, { jumpToMessage } from "../user-messages/index.js";

test("server registers just the browser module with view access", () => {
    const clients = [];

    server({}, { client: (...args) => clients.push(args) });
    assert.deepEqual(clients, [["user-messages", { access: "view" }]]);
});

test("browser entry uses a native persistent panel with menu and launcher actions", () => {
    const specs = {};
    const pocket = {
        style: (path) => { specs.style = path; },
        panel: (spec) => { specs.panel = spec; },
        menu: (spec) => { specs.menu = spec; },
        launcher: (spec) => { specs.launcher = spec; },
        sheet: () => assert.fail("The outline must not open as a transient sheet"),
        topbar: () => assert.fail("Native panels already provide a topbar button"),
    };
    const cleanup = setup(pocket);

    assert.equal(specs.style, "style.css");
    assert.equal(specs.panel.title, "Your messages");
    assert.equal(specs.panel.wide, undefined);

    for (const kind of ["menu", "launcher"]) {
        assert.equal(specs[kind].panel, specs.panel.id);
        assert.equal(specs[kind].sheet, undefined);
    }

    assert.equal(typeof cleanup, "function");
    cleanup();
});

function navigation(reveal) {
    const notices = [];
    const calls = [];
    const pocket = {
        conversationId: () => 7,
        reveal: (id) => { calls.push(id); return reveal(id); },
        notify: (...notice) => notices.push(notice),
        openSheet: () => assert.fail("A jump must not reopen a sheet over newer app navigation"),
        closePanel: () => assert.fail("A message jump must not close a docked panel"),
    };

    return { pocket, notices, calls };
}

test("jump uses the stable message ID and keeps the docked panel open", async () => {
    const { pocket, notices, calls } = navigation(async () => true);

    assert.equal(await jumpToMessage(pocket, "123", 7), true);
    assert.deepEqual(calls, ["123"]);
    assert.deepEqual(notices, []);
});

test("cancelled jumps and rejected jumps report without taking over navigation", async () => {
    const cancelled = navigation(async () => false);

    assert.equal(await jumpToMessage(cancelled.pocket, "123", 7), false);
    assert.equal(cancelled.notices[0][0], "info");
    const failed = navigation(async () => { throw new Error("Offline"); });

    assert.equal(await jumpToMessage(failed.pocket, "123", 7), false);
    assert.deepEqual(failed.notices, [["error", "Could not jump to the message: Offline"]]);
});

test("stale clicks and late failures cannot affect another session or a disposed module", async () => {
    const stale = navigation(async () => false);

    assert.equal(await jumpToMessage(stale.pocket, "123", 8), false);
    assert.deepEqual(stale.calls, []);
    let finish;
    const delayed = navigation(() => new Promise((resolve) => { finish = resolve; }));
    let active = true;
    const jumping = jumpToMessage(delayed.pocket, "123", 7, () => active);

    active = false;
    finish(false);
    await jumping;
    assert.deepEqual(delayed.notices, []);
});
