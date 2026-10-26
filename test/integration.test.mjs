import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startIntegrationFixture } from "../scripts/serve-integration.mjs";

// Optional: requires an installed Pi Pocket checkout, selected by PI_POCKET_SOURCE.
// It runs the real HTTP server and extension loader, with disposable data and a
// scripted model. Browser-only projection/reveal is covered by manual UI testing.
test("User messages integrates with a real Pi Pocket server", { timeout: 120_000 }, async (t) => {
    const fixture = await startIntegrationFixture({ port: 0, watchFiles: false, log: () => {} });
    t.after(() => fixture.close());
    const { app, metadata } = fixture;
    const { base, sessions } = metadata;

    async function signIn(url) {
        const response = await fetch(url, { redirect: "manual" });

        assert.equal(response.status, 303);
        const cookie = response.headers.get("set-cookie")?.split(";")[0];

        assert.ok(cookie?.startsWith("pocket_auth="));

        return cookie;
    }

    const cookie = await signIn(metadata.ownerUrl);
    const viewerCookie = await signIn(metadata.viewerUrl);
    const request = (path, options = {}) => fetch(new URL(path, base), {
        ...options,
        headers: { cookie, "X-Pocket": "1", ...options.headers },
    });
    async function json(path, options) {
        const response = await request(path, options);
        const body = await response.json();

        assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);

        return body;
    }

    const hello = await json("/api/me");
    const module = hello.server.ui.find((entry) => entry.module === "user-messages");
    let allMessages;
    let cursor;

    await t.test("the installed extension serves its exact browser assets after sign-in", async () => {
        assert.ok(module, "The real loader must publish the installed browser module");

        for (const file of ["index.js", "model.js", "style.css"]) {
            const path = new URL(file, new URL(module.url, base));
            const response = await request(path);

            assert.equal(response.status, 200);
            assert.match(response.headers.get("content-type"), file.endsWith(".css") ? /text\/css/ : /javascript/);
            assert.equal(
                await response.text(),
                await readFile(new URL(`../user-messages/${file}`, import.meta.url), "utf8"),
            );
        }

        const anonymous = await fetch(new URL(module.url, base));

        assert.equal(anonymous.status, 401);
        const viewer = await json("/api/me", { headers: { cookie: viewerCookie } });

        assert.ok(viewer.server.ui.some((entry) => entry.module === module.module));
        assert.equal((await request(module.url, { headers: { cookie: viewerCookie } })).status, 200);
    });

    await t.test("205 user prompts paginate as 100, 100, 5 without replies or duplicates", async () => {
        const newest = await json(`/api/c/${sessions.first}/messages?limit=100`);

        assert.equal(newest.messages.length, 100);
        assert.match(newest.messages[0].text, /^Prompt 106:/);
        assert.match(newest.messages.at(-1).text, /^Prompt 205:/);
        assert.equal(newest.before, newest.messages[0].id);
        cursor = newest.before;
        const middle = await json(`/api/c/${sessions.first}/messages?limit=100&before=${cursor}`);

        assert.equal(middle.messages.length, 100);
        assert.match(middle.messages[0].text, /^Prompt 006:/);
        assert.equal(middle.before, middle.messages[0].id);
        const oldest = await json(`/api/c/${sessions.first}/messages?limit=100&before=${middle.before}`);

        assert.equal(oldest.messages.length, 5);
        assert.equal(oldest.before, null);
        allMessages = [...oldest.messages, ...middle.messages, ...newest.messages];
        assert.equal(new Set(allMessages.map((entry) => entry.id)).size, 205);

        for (const [index, entry] of allMessages.entries()) {
            assert.equal(entry.kind, "user");
            assert.match(entry.text, new RegExp(`^Prompt ${String(index + 1).padStart(3, "0")}:`));
            assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0);
            assert.equal(typeof entry.at, "number");
        }
    });

    await t.test("author identity and long Unicode messages survive the server boundary", async () => {
        assert.match(allMessages[202].text, /中文搜索 测试用户消息 😀/);
        const long = allMessages[203];

        // HTTP returns ClientEntry, not MessageInfo. The real browser API clips
        // this text to 1,000 and adds `clipped`; do not invent those HTTP fields.
        assert.ok(long.text.length > 1000);
        assert.ok(long.text.endsWith("OUTSIDE_EXCERPT"));
        assert.ok(!long.text.slice(0, 1000).includes("OUTSIDE_EXCERPT"));
        const room = await app.room(sessions.first);

        try {
            const authorId = room.authors[String(allMessages[24].id)];

            assert.equal(hello.users.find((person) => person.id === authorId)?.name, "Alex Example");
            assert.equal(room.authors[String(allMessages[0].id)], hello.user.id);
        } finally {
            app.releaseRoom(room);
        }
    });

    await t.test("other sessions and empty sessions have isolated message pages", async () => {
        const other = await json(`/api/c/${sessions.second}/messages`);
        const empty = await json(`/api/c/${sessions.empty}/messages`);

        assert.equal(other.before, null);
        assert.deepEqual(other.messages.map((entry) => entry.text), ["Other session only: violet lighthouse"]);
        assert.ok(!allMessages.some((entry) => entry.id === other.messages[0].id));
        assert.deepEqual(empty, { messages: [], before: null });
        const wrongSessionCursor = await request(`/api/c/${sessions.second}/messages?before=${cursor}`);

        assert.equal(wrongSessionCursor.status, 409);
        const viewer = await json(`/api/c/${sessions.first}/messages?limit=1`, { headers: { cookie: viewerCookie } });

        assert.match(viewer.messages[0].text, /^Prompt 205:/);
        const anonymous = await fetch(`${base}/api/c/${sessions.first}/messages`);

        assert.equal(anonymous.status, 401);
    });

    await t.test("New context invalidates the saved cursor and allows a fresh empty page", async () => {
        const response = await request(`/api/c/${sessions.first}/reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });

        assert.equal(response.status, 200, await response.text());
        const stale = await request(`/api/c/${sessions.first}/messages?before=${cursor}`);

        assert.equal(stale.status, 409);
        assert.match((await stale.json()).error, /context changed/);
        assert.deepEqual(await json(`/api/c/${sessions.first}/messages`), { messages: [], before: null });
        assert.equal((await json(`/api/c/${sessions.second}/messages`)).messages.length, 1);
    });
});
