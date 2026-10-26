#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultDataDir = () => process.env.PI_POCKET_DIR || join(homedir(), ".pi-pocket");

async function packageScope(directory) {
    for (let current = directory; ; current = dirname(current)) {
        const path = join(current, "package.json");

        try {
            const json = JSON.parse(await readFile(path, "utf8"));

            return { path, type: json?.type ?? "unspecified" };
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw new Error(`Cannot read package scope ${path}: ${error.message}`);
            }
        }

        if (dirname(current) === current) {
            return null;
        }
    }
}

/** Import the installed entry in a fresh Node process, as Pocket's loader does. */
export async function checkInstallation({ dataDir = defaultDataDir(), env = process.env } = {}) {
    const entry = join(resolve(dataDir), "extensions", "user-messages.ts");
    const scope = await packageScope(dirname(entry));
    const probe = `
        const loaded = await import(process.argv[1]);
        if (typeof loaded.default !== "function" || loaded.pocketApi !== 1) {
            throw new Error("Installed entry does not export the expected Pocket module.");
        }
    `;
    const moduleFlags = [];

    for (let index = 0; index < process.execArgv.length; index += 1) {
        const arg = process.execArgv[index];

        if (["--no-experimental-detect-module", "--experimental-detect-module"].includes(arg) || arg.startsWith("--experimental-default-type=")) {
            moduleFlags.push(arg);
        } else if (arg === "--experimental-default-type") {
            moduleFlags.push(arg, process.execArgv[++index]);
        }
    }

    const result = spawnSync(process.execPath, [...moduleFlags, "--input-type=module", "--eval", probe, pathToFileURL(entry).href], {
        env,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
    });

    return {
        ok: result.status === 0 && !result.error,
        entry,
        nodeVersion: process.version,
        nodeExecutable: process.execPath,
        packageScope: scope,
        ...(result.status === 0 && !result.error ? {} : {
            error: result.error?.message || result.stderr.trim() || `Loader exited with status ${result.status}.`,
        }),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        let dataDir;

        if (args.length === 2 && args[0] === "--dir" && !args[1].startsWith("--")) {
            dataDir = args[1];
        } else if (args.length !== 0) {
            throw new Error("Usage: node scripts/check-install.mjs [--dir <Pi Pocket data directory>]");
        }

        const result = await checkInstallation({ dataDir });

        console.log(`Node: ${result.nodeVersion} (${result.nodeExecutable})`);
        console.log(`Entry: ${result.entry}`);
        console.log(`Package scope: ${result.packageScope ? `${result.packageScope.path} (type: ${result.packageScope.type})` : "none"}`);
        console.log(`Module auto-detection disabled: ${process.execArgv.includes("--no-experimental-detect-module") || /(?:^|\s)--no-experimental-detect-module(?:\s|$)/.test(process.env.NODE_OPTIONS || "")}`);
        console.log(`Load: ${result.ok ? "PASS" : "FAIL"}`);

        if (!result.ok) {
            console.error(result.error);
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
