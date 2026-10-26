#!/usr/bin/env node
/** A real Pi Pocket server with disposable data and a local, scripted model. */
import { watch } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install } from "./install.mjs";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = process.env.PI_POCKET_SOURCE || resolve(extensionRoot, "../pi-pocket");

/** One fixture per process: upstream helpers own a process-wide isolated Pi configuration. */
export async function startIntegrationFixture({
    source = defaultSource,
    port = 8898,
    host = "127.0.0.2",
    messageCount = 205,
    watchFiles = true,
    log = console.log,
} = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("Port must be an integer between 0 and 65535.");
    }

    if (!Number.isInteger(messageCount) || messageCount < 1) {
        throw new Error("Message count must be a positive integer.");
    }

    const upstream = resolve(source);
    const moduleAt = (path) => pathToFileURL(join(upstream, path)).href;
    // This must precede any upstream server import: it isolates auth, skills and settings.
    const helpers = await import(moduleAt("test/helpers.ts"));
    const { cleanUp, context, newSession, openApp, owner, root, say, scriptedModel } = helpers;
    const { createHandler } = await import(moduleAt("src/server/http.ts"));
    const { version } = JSON.parse(await readFile(join(upstream, "package.json"), "utf8"));
    const dataDir = join(root, "data");
    let app;
    let server;
    let closing;
    const watchers = [];
    let syncing = Promise.resolve();

    const close = () => (closing ??= (async () => {
        for (const watcher of watchers) {
            watcher.close();
        }

        await syncing.catch(() => {});
        const serverClosed = server?.listening
            ? new Promise((resolveClose) => server.close(resolveClose))
            : Promise.resolve();

        server?.closeAllConnections();
        // App shutdown closes upgraded/browser connections that server.close cannot force.
        await app?.close();
        await serverClosed;
        cleanUp();
    })());

    try {
        await install({ dataDir });
        app = await openApp(scriptedModel(), dataDir);
        await app.setExtensionEnabled(owner(app), "user-messages.ts", true);

        const first = await newSession(app);
        const second = await newSession(app);
        const empty = await newSession(app);
        const guest = app.config.addUser("Alex Example", "guest");
        const viewer = app.config.addUser("Read Only", "viewer");

        log(`Seeding ${messageCount} user messages in an isolated Pi Pocket ${version}...`);

        for (let index = 1; index <= messageCount; index += 1) {
            let text = `Prompt ${String(index).padStart(3, "0")}: integration history message`;

            if (index === 1) {
                text = "Prompt 001: oldest fork target — revise this earlier decision";
            } else if (index === messageCount - 2) {
                text = `Prompt ${String(index).padStart(3, "0")}: 中文搜索 测试用户消息 😀`;
            } else if (index === messageCount - 1) {
                text = `Prompt ${String(index).padStart(3, "0")}: long excerpt ${"longword".repeat(150)} OUTSIDE_EXCERPT`;
            }

            if (index % 25 === 0) {
                const { submissionId } = await app.commands.submit(first, guest.user, {
                    text,
                    requestId: crypto.randomUUID(),
                });

                await (await app.harness.submission(submissionId, context)).wait(context);
            } else {
                await say(app, first, text);
            }

            if (index % 50 === 0) {
                log(`Seeded ${index}/${messageCount} messages.`);
            }
        }

        await say(app, second, "Other session only: violet lighthouse");
        server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));
        await new Promise((resolveListen, reject) => {
            server.once("error", reject);
            server.listen(port, host, () => {
                server.off("error", reject);
                resolveListen();
            });
        });

        const base = `http://${host}:${server.address().port}`;
        const metadata = {
            pid: process.pid,
            base,
            upstream,
            pocketVersion: version,
            dataDir,
            messageCount,
            sessions: { first, second, empty },
            ownerUrl: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            guestUrl: `${base}/login?token=${encodeURIComponent(guest.token)}`,
            viewerUrl: `${base}/login?token=${encodeURIComponent(viewer.token)}`,
        };

        if (watchFiles) {
            app.loader.watch();

            const runtime = new Set([
                "user-messages.ts", "user-messages/index.js", "user-messages/model.js", "user-messages/style.css",
            ]);

            for (const directory of ["", "user-messages"]) {
                watchers.push(watch(join(extensionRoot, directory), (_event, file) => {
                    const relative = [directory, file?.toString()].filter(Boolean).join("/");

                    if (!runtime.has(relative) || closing) {
                        return;
                    }

                    syncing = syncing.then(async () => {
                        await copyFile(join(extensionRoot, relative), join(dataDir, "extensions", relative));
                    }).catch((error) => log(`Could not reload ${relative}: ${error.message}`));
                }));
            }
        }

        return { app, metadata, close };
    } catch (error) {
        await close();
        throw error;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let fixture;

    try {
        const options = {};
        let metadataPath = join(extensionRoot, "artifacts", "integration-server.json");
        const args = process.argv.slice(2);

        for (let index = 0; index < args.length; index += 1) {
            const arg = args[index];

            if (!["--source", "--port", "--metadata"].includes(arg) || !args[index + 1]) {
                throw new Error("Usage: node scripts/serve-integration.mjs [--source <pi-pocket checkout>] [--port <port>] [--metadata <file>]");
            }

            const value = args[++index];

            if (arg === "--metadata") {
                metadataPath = resolve(value);
            } else if (arg === "--port") {
                options.port = Number(value);
            } else {
                options.source = value;
            }
        }

        fixture = await startIntegrationFixture(options);
        await mkdir(dirname(metadataPath), { recursive: true });
        await writeFile(metadataPath, `${JSON.stringify(fixture.metadata, null, 2)}\n`, { mode: 0o600 });
        console.log(`Ready: ${fixture.metadata.ownerUrl}`);
        console.log(`Sessions: ${JSON.stringify(fixture.metadata.sessions)}`);
        console.log(`Metadata: ${metadataPath}`);
        console.log("Ctrl+C stops the isolated server and deletes its temporary data.");

        const stop = async () => {
            await fixture.close();
            process.exit(0);
        };

        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    } catch (error) {
        await fixture?.close();
        console.error(error);
        process.exitCode = 1;
    }
}
