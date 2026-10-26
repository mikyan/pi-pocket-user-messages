#!/usr/bin/env node
import * as nodeFs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleName = "user-messages";
const browserFiles = ["index.js", "model.js", "style.css"];
const defaultSource = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function statOrNull(path, fs) {
    try {
        return await fs.lstat(path);
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }

        throw error;
    }
}

// lstat each existing ancestor: neither the target nor a parent may redirect writes.
async function checkPath(path, fs) {
    let current = parse(path).root;

    for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        const stat = await statOrNull(current, fs);

        if (stat?.isSymbolicLink()) {
            throw new Error(`Refusing a symbolic-link path: ${current}`);
        }
    }
}

async function expectKind(path, kind, fs, optional = false) {
    const stat = await statOrNull(path, fs);

    if (!stat && optional) {
        return false;
    }

    if (!stat || stat.isSymbolicLink() || !stat[kind]()) {
        throw new Error(`Expected ${kind === "isFile" ? "a regular file" : "a directory"}: ${path}`);
    }

    return true;
}

/** Install only this extension. fs may be injected to exercise rollback in tests. */
export async function install({
    dataDir = process.env.PI_POCKET_DIR || join(homedir(), ".pi-pocket"),
    sourceRoot = defaultSource,
    force = false,
    fs = nodeFs,
} = {}) {
    const data = resolve(dataDir);
    const source = resolve(sourceRoot);
    const extensions = join(data, "extensions");
    const names = [`${moduleName}.ts`, moduleName];
    const existing = [];

    await checkPath(extensions, fs);
    await expectKind(extensions, "isDirectory", fs, true);
    await checkPath(source, fs);
    await expectKind(join(source, `${moduleName}.ts`), "isFile", fs);
    await expectKind(join(source, moduleName), "isDirectory", fs);

    for (const file of browserFiles) {
        await expectKind(join(source, moduleName, file), "isFile", fs);
    }

    for (const name of names) {
        const target = join(extensions, name);

        await checkPath(target, fs);

        if (await expectKind(target, name.endsWith(".ts") ? "isFile" : "isDirectory", fs, true)) {
            existing.push(name);
        }
    }

    if (existing.length && !force) {
        throw new Error("User messages is already installed. Use --force to back it up and replace it.");
    }

    const backups = join(data, "extension-backups");

    if (existing.length) {
        await checkPath(backups, fs);
        await expectKind(backups, "isDirectory", fs, true);
    }

    await fs.mkdir(extensions, { recursive: true });
    const staging = await fs.mkdtemp(join(data, ".user-messages-stage-"));
    const moved = [];
    const installed = [];
    let backupDir = null;

    try {
        await fs.copyFile(join(source, names[0]), join(staging, names[0]));
        await fs.mkdir(join(staging, moduleName));

        for (const file of browserFiles) {
            await fs.copyFile(join(source, moduleName, file), join(staging, moduleName, file));
        }

        if (existing.length) {
            await fs.mkdir(backups, { recursive: true });
            backupDir = await fs.mkdtemp(join(backups, "user-messages-"));

            for (const name of existing) {
                await fs.rename(join(extensions, name), join(backupDir, name));
                moved.push(name);
            }
        }

        // Put browser assets in place before exposing the server entry to Pocket's watcher.
        for (const name of [...names].reverse()) {
            await fs.rename(join(staging, name), join(extensions, name));
            installed.push(name);
        }
    } catch (error) {
        const rollbackErrors = [];

        for (const name of installed.reverse()) {
            try {
                await fs.rm(join(extensions, name), { recursive: true, force: true });
            } catch (failure) {
                rollbackErrors.push(failure);
            }
        }

        for (const name of moved.reverse()) {
            try {
                await fs.rename(join(backupDir, name), join(extensions, name));
            } catch (failure) {
                rollbackErrors.push(failure);
            }
        }

        if (rollbackErrors.length) {
            throw new AggregateError(
                [error, ...rollbackErrors],
                `Installation failed; recovery was incomplete. Originals remain in ${backupDir || staging}.`,
            );
        }

        throw error;
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }

    return { extensions, backupDir };
}

export function parseArgs(args) {
    const options = {};

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];

        if (arg === "--force") {
            options.force = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--dir") {
            const value = args[++index];

            if (!value || value.startsWith("--")) {
                throw new Error("--dir requires a Pi Pocket data directory.");
            }

            options.dataDir = value;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArgs(process.argv.slice(2));

        if (options.help) {
            console.log("Usage: node scripts/install.mjs [--dir <Pi Pocket data directory>] [--force]");
            console.log("Default: PI_POCKET_DIR or ~/.pi-pocket. --force keeps a backup in extension-backups/.");
        } else {
            const result = await install(options);

            console.log(`Installed User messages in ${result.extensions}`);

            if (result.backupDir) {
                console.log(`Previous version backed up in ${result.backupDir}`);
            }

            console.log("In Pi Pocket, open Menu → Extensions → Installed and enable User messages.");
        }
    } catch (error) {
        console.error(`${basename(process.argv[1])}: ${error.message}`);
        process.exitCode = 1;
    }
}
