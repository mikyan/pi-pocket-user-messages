import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install } from "../scripts/install.mjs";
import { checkInstallation } from "../scripts/check-install.mjs";

test("ESM repair loads the installed entry under CommonJS without changing ancestor configuration", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "um-commonjs-regression-"));

    t.after(() => rm(root, { recursive: true, force: true }));
    const config = '{"type":"commonjs","private":true}\n';

    await writeFile(join(root, "package.json"), config);
    const dataDir = join(root, "data");

    await install({ dataDir });
    const broken = await checkInstallation({ dataDir });

    assert.equal(broken.ok, false);
    assert.match(broken.error, /SyntaxError: Unexpected token 'export'/);
    assert.equal(broken.packageScope.type, "commonjs");
    await install({ dataDir, force: true, esm: true });
    const repaired = await checkInstallation({ dataDir });

    assert.equal(repaired.ok, true, repaired.error);
    assert.equal(repaired.packageScope.path, join(dataDir, "extensions", "package.json"));
    assert.equal(repaired.packageScope.type, "module");
    assert.equal(await readFile(join(root, "package.json"), "utf8"), config);
});

test("ESM repair loads an installed entry when Node module auto-detection is disabled", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "um-no-detect-regression-"));

    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), "{}\n");
    const dataDir = join(root, "data");
    const env = { ...process.env, NODE_OPTIONS: "--no-experimental-detect-module" };

    await install({ dataDir });
    const broken = await checkInstallation({ dataDir, env });

    assert.equal(broken.ok, false);
    // Node patches differ here: 24.14 reports the export syntax error; later
    // patches can report a require(esm) cycle. Both must become loadable.
    assert.match(broken.error, /Unexpected token 'export'|ERR_REQUIRE_CYCLE_MODULE/);
    await install({ dataDir, force: true, esm: true });
    const repaired = await checkInstallation({ dataDir, env });

    assert.equal(repaired.ok, true, repaired.error);
});

test("a closer typeless package blocks inheritance from an ESM ancestor", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "um-scope-regression-"));

    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    const dataDir = join(root, "data");

    await mkdir(dataDir);
    await writeFile(join(dataDir, "package.json"), "{}\n");
    await install({ dataDir });
    const result = await checkInstallation({ dataDir });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.packageScope.path, join(dataDir, "package.json"));
    assert.equal(result.packageScope.type, "unspecified");
});

test("installer CLI reports a load failure, repairs it, and requests a server restart", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "um-cli-regression-"));

    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), "{}\n");
    const dataDir = join(root, "data");
    const installer = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
    const checker = fileURLToPath(new URL("../scripts/check-install.mjs", import.meta.url));
    const run = (script, ...args) => spawnSync(process.execPath, ["--no-experimental-detect-module", script, "--dir", dataDir, ...args], {
        encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    const broken = run(installer);

    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stderr, /Files were installed.*load check failed/);
    assert.match(broken.stderr, /--force --esm/);
    const diagnosis = run(checker);

    assert.equal(diagnosis.status, 1, diagnosis.stderr);
    assert.match(diagnosis.stdout, /Load: FAIL/);
    const repaired = run(installer, "--force", "--esm");

    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /Installed and load-checked/);
    assert.match(repaired.stdout, /Restart the Pi Pocket server/);
    const checked = run(checker);

    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Load: PASS/);
});
