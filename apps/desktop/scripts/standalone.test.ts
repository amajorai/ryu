import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("standalone.mjs", import.meta.url));

test("standalone preparation preserves the full manifest and optional field fallbacks", () => {
	const appDir = mkdtempSync(join(tmpdir(), "desktop-standalone-test-"));
	let bundleDir: string | undefined;
	const manifest = {
		id: "com.example.contract-test",
		name: 42,
		version: "1.0.0",
		future: { retained: true },
		runnables: [{ kind: "companion", config: { ui_entry: 42, future: true } }],
		sidecars: [
			{
				name: "external",
				process: { kind: "local", command: 42, command_env: "TEST_COMMAND" },
			},
		],
	};
	try {
		writeFileSync(join(appDir, "manifest.json"), JSON.stringify(manifest));
		const result = spawnSync("node", [scriptPath, appDir, "--prepare-only"], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const bundlePath = result.stdout.match(/: (.+)\n/)?.[1];
		if (!bundlePath) {
			throw new Error(`No standalone bundle path returned: ${result.stderr}`);
		}
		bundleDir = dirname(bundlePath);
		expect(JSON.parse(readFileSync(bundlePath, "utf8"))).toEqual({
			schemaVersion: 1,
			appId: manifest.id,
			appName: manifest.name,
			version: manifest.version,
			manifest,
			sidecars: [
				{
					command: null,
					commandEnv: "TEST_COMMAND",
					mode: "core-provisioned",
					name: "external",
				},
			],
			uiCode: null,
		});
	} finally {
		rmSync(appDir, { recursive: true, force: true });
		if (bundleDir) {
			rmSync(bundleDir, { recursive: true, force: true });
		}
	}
});

test("standalone preparation embeds declared HTML and preserves extension fields", () => {
	const appDir = mkdtempSync(join(tmpdir(), "desktop-standalone-test-"));
	let bundleDir: string | undefined;
	const html = "<!doctype html><title>Test companion</title>";
	const manifest = {
		id: "com.example.contract-test",
		name: "Contract Test",
		version: "1.0.0",
		future: { retained: true },
		runnables: [
			{
				kind: "companion",
				config: { ui_entry: "companion.html", future: true },
			},
		],
	};
	try {
		writeFileSync(join(appDir, "manifest.json"), JSON.stringify(manifest));
		writeFileSync(join(appDir, "companion.html"), html);
		const result = spawnSync("node", [scriptPath, appDir, "--prepare-only"], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const bundlePath = result.stdout.match(/: (.+)\n/)?.[1];
		if (!bundlePath) {
			throw new Error(`No standalone bundle path returned: ${result.stderr}`);
		}
		bundleDir = dirname(bundlePath);
		expect(JSON.parse(readFileSync(bundlePath, "utf8"))).toMatchObject({
			manifest: {
				...manifest,
				ui_code_sha256: createHash("sha256").update(html).digest("hex"),
			},
			uiCode: html,
		});
	} finally {
		rmSync(appDir, { recursive: true, force: true });
		if (bundleDir) {
			rmSync(bundleDir, { recursive: true, force: true });
		}
	}
});
