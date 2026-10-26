import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { install, parseArgs } from "../scripts/install.mjs";

async function fixture(t) {
    const root = await fs.mkdtemp(join(tmpdir(), "pocket-user-messages-test-"));
    const sourceRoot = join(root, "source");
    const dataDir = join(root, "data");

    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(join(sourceRoot, "user-messages"), { recursive: true });
    await fs.writeFile(join(sourceRoot, "user-messages.ts"), "new server");

    for (const file of ["index.js", "model.js", "style.css"]) {
        await fs.writeFile(join(sourceRoot, "user-messages", file), `new ${file}`);
    }

    await fs.writeFile(join(sourceRoot, "private.txt"), "do not install");

    return { root, sourceRoot, dataDir };
}

const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

// File symlinks require privileges on Windows. Exercise the same lstat boundary
// there when unavailable; directory junction tests below still use real links.
async function fileLinkFs(source, target) {
    try {
        await fs.symlink(source, target);

        return fs;
    } catch (error) {
        if (process.platform !== "win32" || error.code !== "EPERM") {
            throw error;
        }

        return {
            ...fs,
            async lstat(path) {
                return resolve(path) === resolve(target)
                    ? { isSymbolicLink: () => true }
                    : fs.lstat(path);
            },
        };
    }
}

test("installs only extension runtime files and leaves other extensions alone", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");

    await fs.mkdir(extensions, { recursive: true });
    await fs.writeFile(join(extensions, "other.ts"), "keep");
    const result = await install(context);

    assert.equal(result.backupDir, null);
    assert.deepEqual((await fs.readdir(extensions)).sort(), ["other.ts", "user-messages", "user-messages.ts"]);
    assert.deepEqual((await fs.readdir(join(extensions, "user-messages"))).sort(), ["index.js", "model.js", "style.css"]);
    assert.equal(await fs.readFile(join(extensions, "other.ts"), "utf8"), "keep");
});

test("an existing installation requires --force without changing it", async (t) => {
    const context = await fixture(t);

    await install(context);
    await fs.writeFile(join(context.dataDir, "extensions", "user-messages.ts"), "old server");
    await assert.rejects(install(context), /already installed/);
    assert.equal(await fs.readFile(join(context.dataDir, "extensions", "user-messages.ts"), "utf8"), "old server");
    assert.deepEqual(await fs.readdir(context.dataDir), ["extensions"]);
});

test("--force preserves the previous version outside the watched extensions folder", async (t) => {
    const context = await fixture(t);

    await install(context);
    await fs.writeFile(join(context.dataDir, "extensions", "user-messages.ts"), "old server");
    await fs.writeFile(join(context.dataDir, "extensions", "user-messages", "custom.txt"), "custom old asset");
    const result = await install({ ...context, force: true });

    assert.ok(result.backupDir.startsWith(join(context.dataDir, "extension-backups")));
    assert.equal(await fs.readFile(join(result.backupDir, "user-messages.ts"), "utf8"), "old server");
    assert.equal(await fs.readFile(join(result.backupDir, "user-messages", "custom.txt"), "utf8"), "custom old asset");
    assert.equal(await fs.readFile(join(result.extensions, "user-messages.ts"), "utf8"), "new server");
});

test("failed replacement restores both originals", async (t) => {
    const context = await fixture(t);

    await install(context);
    const extensions = join(context.dataDir, "extensions");

    await fs.writeFile(join(extensions, "user-messages.ts"), "old server");
    await fs.writeFile(join(extensions, "user-messages", "index.js"), "old browser");
    const faultyFs = {
        ...fs,
        async rename(from, to) {
            if (from.includes(".user-messages-stage-") && from.endsWith("user-messages.ts")) {
                throw new Error("simulated disk failure");
            }

            return fs.rename(from, to);
        },
    };

    await assert.rejects(install({ ...context, force: true, fs: faultyFs }), /simulated disk failure/);
    assert.equal(await fs.readFile(join(extensions, "user-messages.ts"), "utf8"), "old server");
    assert.equal(await fs.readFile(join(extensions, "user-messages", "index.js"), "utf8"), "old browser");
    assert.ok(!(await fs.readdir(context.dataDir)).some((name) => name.startsWith(".user-messages-stage-")));
});

test("rejects a symbolic-link extensions directory", async (t) => {
    const context = await fixture(t);
    const elsewhere = join(context.root, "elsewhere");

    await fs.mkdir(elsewhere);
    await fs.mkdir(context.dataDir);
    await fs.symlink(elsewhere, join(context.dataDir, "extensions"), directoryLinkType);
    await assert.rejects(install(context), /symbolic-link/);
    assert.deepEqual(await fs.readdir(elsewhere), []);
});

test("rejects a linked data-directory ancestor before writing through it", async (t) => {
    const context = await fixture(t);
    const elsewhere = join(context.root, "elsewhere");
    const linkedParent = join(context.root, "linked-parent");

    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, linkedParent, directoryLinkType);
    await assert.rejects(
        install({ ...context, dataDir: join(linkedParent, "new-data") }),
        /symbolic-link/,
    );
    assert.deepEqual(await fs.readdir(elsewhere), []);
});

test("rejects a linked source ancestor before creating the destination", async (t) => {
    const context = await fixture(t);
    const sourceParent = join(context.root, "source-parent");
    const linkedParent = join(context.root, "linked-parent");

    await fs.mkdir(sourceParent);
    await fs.rename(context.sourceRoot, join(sourceParent, "source"));
    await fs.symlink(sourceParent, linkedParent, directoryLinkType);
    await assert.rejects(
        install({ ...context, sourceRoot: join(linkedParent, "source") }),
        /symbolic-link/,
    );
    await assert.rejects(fs.stat(context.dataDir), { code: "ENOENT" });
});

test("rejects symbolic-link module targets even with --force", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");
    const elsewhere = join(context.root, "elsewhere.ts");

    await fs.mkdir(extensions, { recursive: true });
    await fs.writeFile(elsewhere, "untouched");
    const linkedFs = await fileLinkFs(elsewhere, join(extensions, "user-messages.ts"));

    await assert.rejects(install({ ...context, force: true, fs: linkedFs }), /symbolic-link/);
    assert.equal(await fs.readFile(elsewhere, "utf8"), "untouched");
});

test("rejects missing or linked source assets before touching the destination", async (t) => {
    const context = await fixture(t);
    const file = join(context.sourceRoot, "user-messages", "model.js");

    await fs.rm(file);
    await assert.rejects(install(context), /regular file/);
    const linkedFs = await fileLinkFs(join(context.sourceRoot, "private.txt"), file);

    await assert.rejects(install({ ...context, fs: linkedFs }), /regular file/);
    await assert.rejects(fs.stat(context.dataDir), { code: "ENOENT" });
});

test("default installation never changes the shared package configuration", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");
    const original = '{ "type": "commonjs", "private": true }\r\n';

    await fs.mkdir(extensions, { recursive: true });
    await fs.writeFile(join(extensions, "package.json"), original);
    await install(context);
    assert.equal(await fs.readFile(join(extensions, "package.json"), "utf8"), original);
    await assert.rejects(fs.stat(join(context.dataDir, "extension-backups")), { code: "ENOENT" });
});

test("--esm publishes browser assets and the module marker before the server entry", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");
    const publication = [];
    const observedFs = {
        ...fs,
        async rename(from, to) {
            if (from.includes(".user-messages-stage-")) {
                publication.push(to);

                if (to === join(extensions, "user-messages.ts")) {
                    assert.equal(JSON.parse(await fs.readFile(join(extensions, "package.json"), "utf8")).type, "module");
                    assert.equal(await fs.readFile(join(extensions, "user-messages", "index.js"), "utf8"), "new index.js");
                }
            }

            return fs.rename(from, to);
        },
    };

    const result = await install({ ...context, esm: true, fs: observedFs });

    assert.deepEqual(publication, ["user-messages", "package.json", "user-messages.ts"].map((name) => join(extensions, name)));
    assert.equal(result.backupDir, null);
    assert.deepEqual(JSON.parse(await fs.readFile(join(extensions, "package.json"), "utf8")), { type: "module" });
});

test("--esm preserves package metadata and backs up the exact original with the plugin", async (t) => {
    const context = await fixture(t);

    await install(context);
    const extensions = join(context.dataDir, "extensions");
    const original = '{\r\n  "name": "my-extensions", "type": "commonjs", "private": true,\r\n  "imports": { "#helper": "./helper.js" }\r\n}\r\n';

    await fs.writeFile(join(extensions, "package.json"), original);
    await fs.writeFile(join(extensions, "other.ts"), "other extension");
    await fs.writeFile(join(extensions, "user-messages.ts"), "old server");
    const result = await install({ ...context, force: true, esm: true });

    assert.deepEqual(JSON.parse(await fs.readFile(join(extensions, "package.json"), "utf8")), {
        ...JSON.parse(original), type: "module",
    });
    assert.equal(await fs.readFile(join(result.backupDir, "package.json"), "utf8"), original);
    assert.equal(await fs.readFile(join(result.backupDir, "user-messages.ts"), "utf8"), "old server");
    assert.equal(await fs.readFile(join(extensions, "other.ts"), "utf8"), "other extension");
});

test("--esm still requires --force to replace installed plugin files", async (t) => {
    const context = await fixture(t);

    await install(context);
    await assert.rejects(install({ ...context, esm: true }), /already installed/);
    await assert.rejects(fs.stat(join(context.dataDir, "extensions", "package.json")), { code: "ENOENT" });
    assert.equal(await fs.readFile(join(context.dataDir, "extensions", "user-messages.ts"), "utf8"), "new server");
});

test("--esm leaves an existing module marker byte-for-byte untouched", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");
    const original = '{ "type":"module", "name":"custom" }\r\n';

    await fs.mkdir(extensions, { recursive: true });
    await fs.writeFile(join(extensions, "package.json"), original);
    const noMarkerWrites = {
        ...fs,
        async writeFile(path, ...args) {
            assert.ok(!String(path).endsWith("package.json"), "An existing module marker needs no rewrite");

            return fs.writeFile(path, ...args);
        },
        async rename(from, to) {
            assert.ok(!from.endsWith("package.json") && !to.endsWith("package.json"), "An unchanged marker needs no backup or replacement");

            return fs.rename(from, to);
        },
    };

    const result = await install({ ...context, esm: true, fs: noMarkerWrites });

    assert.equal(await fs.readFile(join(extensions, "package.json"), "utf8"), original);
    assert.equal(result.backupDir, null);
});

test("--esm rejects malformed and non-object package configurations without changing files", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");

    await install(context);

    for (const original of ["{ broken", "null", "[]"]) {
        await fs.writeFile(join(extensions, "package.json"), original);
        await assert.rejects(install({ ...context, force: true, esm: true }), /package\.json/);
        assert.equal(await fs.readFile(join(extensions, "package.json"), "utf8"), original);
        assert.equal(await fs.readFile(join(extensions, "user-messages.ts"), "utf8"), "new server");
    }

    assert.deepEqual(await fs.readdir(context.dataDir), ["extensions"]);
});

test("--esm refuses a linked package configuration without touching its target", async (t) => {
    const context = await fixture(t);
    const extensions = join(context.dataDir, "extensions");
    const elsewhere = join(context.root, "elsewhere.json");
    const original = '{"type":"commonjs"}';

    await fs.mkdir(extensions, { recursive: true });
    await fs.writeFile(elsewhere, original);
    const linkedFs = await fileLinkFs(elsewhere, join(extensions, "package.json"));

    await assert.rejects(install({ ...context, esm: true, fs: linkedFs }), /symbolic-link/);
    assert.equal(await fs.readFile(elsewhere, "utf8"), original);
    await assert.rejects(fs.stat(join(extensions, "user-messages.ts")), { code: "ENOENT" });
});

for (const original of [null, '{ "type":"commonjs", "private":true }\r\n']) {
    test(`--esm publication failure ${original === null ? "removes a created" : "restores the original"} marker and restores plugin files`, async (t) => {
        const context = await fixture(t);

        await install(context);
        const extensions = join(context.dataDir, "extensions");
        const marker = join(extensions, "package.json");

        if (original !== null) {
            await fs.writeFile(marker, original);
        }

        await fs.writeFile(join(extensions, "user-messages.ts"), "old server");
        await fs.writeFile(join(extensions, "user-messages", "index.js"), "old browser");
        const faultyFs = {
            ...fs,
            async rename(from, to) {
                if (from.includes(".user-messages-stage-") && from.endsWith("user-messages.ts")) {
                    assert.equal(JSON.parse(await fs.readFile(marker, "utf8")).type, "module");
                    throw new Error("simulated entry publication failure");
                }

                return fs.rename(from, to);
            },
        };

        await assert.rejects(install({ ...context, force: true, esm: true, fs: faultyFs }), /simulated entry publication failure/);

        if (original === null) {
            await assert.rejects(fs.stat(marker), { code: "ENOENT" });
        } else {
            assert.equal(await fs.readFile(marker, "utf8"), original);
        }

        assert.equal(await fs.readFile(join(extensions, "user-messages.ts"), "utf8"), "old server");
        assert.equal(await fs.readFile(join(extensions, "user-messages", "index.js"), "utf8"), "old browser");
        assert.ok(!(await fs.readdir(context.dataDir)).some((name) => name.startsWith(".user-messages-stage-")));
    });
}

test("parses documented flags and rejects mistakes", () => {
    assert.deepEqual(parseArgs(["--dir", "/tmp/pocket", "--force"]), { dataDir: "/tmp/pocket", force: true });
    assert.deepEqual(parseArgs(["--help"]), { help: true });
    assert.deepEqual(parseArgs(["--force", "--esm"]), { force: true, esm: true });
    assert.throws(() => parseArgs(["--dir"]), /requires/);
    assert.throws(() => parseArgs(["--dir", "--force"]), /requires/);
    assert.throws(() => parseArgs(["--typo"]), /Unknown/);
});
