/**
 * create-ryu-app scaffold test.
 *
 * Asserts that:
 *   1. The scaffold produces the expected file set.
 *   2. The generated plugin.json parses against PluginManifestSchema.
 *   3. The generated package.json has the expected shape.
 *   4. Name-stamping works correctly (slug and display name).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema } from "@ryu/sdk/manifest";
import { scaffold } from "./index";

const EXPECTED_FILES = ["plugin.json", "src/agent.ts", "package.json"];

describe("create-ryu-app scaffold", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-scaffold-${Date.now()}`);
		projectDir = scaffold("my-test-app", tmpDir);
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set", () => {
		for (const file of EXPECTED_FILES) {
			const fullPath = join(projectDir, file);
			expect(existsSync(fullPath)).toBe(true);
		}
	});

	it("plugin.json parses against PluginManifestSchema", () => {
		const manifestPath = join(projectDir, "plugin.json");
		const raw = readFileSync(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const result = PluginManifestSchema.safeParse(parsed);
		expect(result.success).toBe(true);
	});

	it("plugin.json contains the correct plugin id slug", () => {
		const raw = readFileSync(join(projectDir, "plugin.json"), "utf8");
		const parsed = JSON.parse(raw) as { id: string; name: string };
		expect(parsed.id).toBe("com.example.my-test-app");
		expect(parsed.name).toBe("My Test App");
	});

	it("plugin.json companion label matches display name", () => {
		const raw = readFileSync(join(projectDir, "plugin.json"), "utf8");
		const parsed = JSON.parse(raw) as { companion?: { label: string } };
		expect(parsed.companion?.label).toBe("My Test App");
	});

	it("generated package.json has correct name and dev script", () => {
		const raw = readFileSync(join(projectDir, "package.json"), "utf8");
		const pkg = JSON.parse(raw) as {
			name: string;
			scripts: Record<string, string>;
			dependencies: Record<string, string>;
		};
		expect(pkg.name).toBe("my-test-app");
		expect(pkg.scripts.dev).toBe("bun run src/agent.ts");
		expect(pkg.dependencies["@ryu/sdk"]).toBeDefined();
	});

	it("plugin.json has at least one agent runnable", () => {
		const raw = readFileSync(join(projectDir, "plugin.json"), "utf8");
		const parsed = JSON.parse(raw) as {
			runnables: Array<{ kind: string }>;
		};
		const agentRunnables = parsed.runnables.filter((r) => r.kind === "agent");
		expect(agentRunnables.length).toBeGreaterThan(0);
	});
});
