/**
 * create-ryu-app scaffold test.
 *
 * The native addon is mocked in test-preload.ts (bunfig.toml) so the zod
 * PluginManifestSchema — the gate this suite exercises — loads without the
 * `@ryuhq/sdk-native` binary.
 *
 * Asserts, for every template:
 *   1. The scaffold produces the expected file set.
 *   2. The generated plugin.json parses against PluginManifestSchema.
 *   3. The manifest has the shape that template promises (agent runnable /
 *      turn hook / widget / companion tool + surface).
 *   4. The authoring src uses the matching defineX factory, and — for the app
 *      templates — the factory output deep-equals the shipped plugin.json, proving
 *      the two never drift.
 *   5. `parseArgs` handles `--template` and rejects bad input.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema } from "@ryuhq/sdk/manifest";
import { parseArgs, scaffold } from "./index.ts";

type Manifest = ReturnType<typeof PluginManifestSchema.parse>;

function readManifest(projectDir: string): Manifest {
	const raw = readFileSync(join(projectDir, "plugin.json"), "utf8");
	return PluginManifestSchema.parse(JSON.parse(raw));
}

// ── default (agent) template — preserves the original scaffold contract ────────

describe("create-ryu-app scaffold (agent, default)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-agent-${Date.now()}`);
		projectDir = scaffold("my-test-app", tmpDir);
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set", () => {
		for (const file of ["plugin.json", "src/agent.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("plugin.json parses against PluginManifestSchema", () => {
		expect(() => readManifest(projectDir)).not.toThrow();
	});

	it("plugin.json contains the correct plugin id slug and name", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-test-app");
		expect(parsed.name).toBe("My Test App");
	});

	it("plugin.json companion label matches display name", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.companion?.label).toBe("My Test App");
	});

	it("generated package.json has correct name and dev script", () => {
		const pkg = JSON.parse(
			readFileSync(join(projectDir, "package.json"), "utf8")
		) as {
			name: string;
			scripts: Record<string, string>;
			dependencies: Record<string, string>;
		};
		expect(pkg.name).toBe("my-test-app");
		expect(pkg.scripts.dev).toBe("bun run src/agent.ts");
		expect(pkg.dependencies["@ryuhq/sdk"]).toBe("^0.0.5");
	});

	it("plugin.json has at least one agent runnable", () => {
		const parsed = readManifest(projectDir);
		const agents = parsed.runnables.filter((r) => r.kind === "agent");
		expect(agents.length).toBeGreaterThan(0);
	});

	it("src/agent.ts imports the scoped @ryuhq/sdk/agent entry (not the legacy @ryu/sdk)", () => {
		const src = readFileSync(join(projectDir, "src/agent.ts"), "utf8");
		expect(src).toContain('from "@ryuhq/sdk/agent"');
		expect(src).not.toContain("@ryu/sdk");
	});
});

// ── a Ryu-branded project name never crashes the manifest gate ─────────────────

describe("create-ryu-app scaffold (Ryu-branded name)", () => {
	let tmpDir: string;

	afterAll(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("falls back to a safe companion label instead of failing validation", () => {
		tmpDir = join(import.meta.dir, `__test-branded-${Date.now()}`);
		// `ryu-helper` → display "Ryu Helper" would impersonate system chrome; the
		// label must NOT crash scaffold (the tool is literally create-ryu-app).
		const projectDir = scaffold("ryu-helper", tmpDir);
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.ryu-helper");
		expect(parsed.name).toBe("Ryu Helper");
		const label = (parsed.companion?.label ?? "").toLowerCase();
		expect(label.includes("ryu")).toBe(false);
		expect(label.includes("system")).toBe(false);
	});
});

// ── hook-plugin template ───────────────────────────────────────────────────────

describe("create-ryu-app scaffold (hook-plugin)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-hook-${Date.now()}`);
		projectDir = scaffold("my-hook", tmpDir, "hook-plugin");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set", () => {
		for (const file of ["plugin.json", "src/plugin.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("manifest is valid and declares a post-assistant-turn hook", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-hook");
		const hooks = parsed.contributes?.turn_hooks ?? [];
		expect(hooks.length).toBeGreaterThan(0);
		expect(hooks[0]?.on).toBe("post_assistant_turn");
		expect(hooks[0]?.code).toContain("host.log");
		// A pure turn-hook plugin contributes no runnables.
		expect(parsed.runnables).toHaveLength(0);
	});

	it("src/plugin.ts uses definePlugin + defineTurnHook", () => {
		const src = readFileSync(join(projectDir, "src/plugin.ts"), "utf8");
		expect(src).toContain(
			'import { definePlugin, defineTurnHook } from "@ryuhq/sdk"'
		);
		expect(src).not.toContain("@ryu/sdk");
	});

	it("dev script targets the plugin entry", () => {
		const pkg = JSON.parse(
			readFileSync(join(projectDir, "package.json"), "utf8")
		) as { scripts: Record<string, string> };
		expect(pkg.scripts.dev).toBe("bun run src/plugin.ts");
	});
});

// ── ryu-app template ───────────────────────────────────────────────────────────

describe("create-ryu-app scaffold (ryu-app)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-ryuapp-${Date.now()}`);
		projectDir = scaffold("my-widget", tmpDir, "ryu-app");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces the expected file set including a widget entry", () => {
		for (const file of [
			"plugin.json",
			"src/app.ts",
			"src/widget.tsx",
			"src/index.html",
			"package.json",
		]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("manifest declares a render widget bound to a ui:// resource", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-widget");
		const widgets = parsed.contributes?.widgets ?? [];
		expect(widgets).toHaveLength(1);
		expect(widgets[0]?.uri).toBe("ui://widget/my-widget.html");
		expect(widgets[0]?.tool_id).toBe("my-widget__render");
		const render = parsed.runnables.find((r) => r.id === "my-widget__render");
		expect(render?.kind).toBe("tool");
		expect((render?.config as { widget?: boolean })?.widget).toBe(true);
	});

	it("stamped src/app.ts defineApp output deep-equals the shipped plugin.json", async () => {
		const mod = (await import(join(projectDir, "src/app.ts"))) as {
			default: unknown;
		};
		expect(mod.default).toEqual(readManifest(projectDir));
	});

	it("the widget source is CSP-safe (no network egress)", () => {
		const widget = readFileSync(join(projectDir, "src/widget.tsx"), "utf8");
		expect(widget).not.toContain("fetch(");
		expect(widget).not.toContain("http://");
		expect(widget).not.toContain("https://");
		expect(widget).toContain("window.openai");
	});

	it("package.json pulls in React for the widget bundle", () => {
		const pkg = JSON.parse(
			readFileSync(join(projectDir, "package.json"), "utf8")
		) as { dependencies: Record<string, string> };
		expect(pkg.dependencies.react).toBeDefined();
		expect(pkg.dependencies["react-dom"]).toBeDefined();
	});
});

// ── companion-plugin template ──────────────────────────────────────────────────

describe("create-ryu-app scaffold (companion-plugin)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-companion-${Date.now()}`);
		projectDir = scaffold("my-panel", tmpDir, "companion-plugin");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("declares an accessible companion tool the widget can call", () => {
		const parsed = readManifest(projectDir);
		const save = parsed.runnables.find((r) => r.id === "my-panel__save");
		expect(save).toBeDefined();
		expect(
			(save?.config as { widget_accessible?: boolean })?.widget_accessible
		).toBe(true);
		// The render tool's widget may call companions because one exists.
		const render = parsed.runnables.find((r) => r.id === "my-panel__render");
		expect(
			(render?.config as { widget_accessible?: boolean })?.widget_accessible
		).toBe(true);
	});

	it("declares a companion surface whose label never impersonates system chrome", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.companion?.label).toBeDefined();
		const label = (parsed.companion?.label ?? "").toLowerCase();
		expect(label.includes("ryu")).toBe(false);
		expect(label.includes("system")).toBe(false);
	});

	it("stamped src/app.ts defineApp output deep-equals the shipped plugin.json", async () => {
		const mod = (await import(join(projectDir, "src/app.ts"))) as {
			default: unknown;
		};
		expect(mod.default).toEqual(readManifest(projectDir));
	});

	it("the widget calls the companion tool via the host bridge", () => {
		const widget = readFileSync(join(projectDir, "src/widget.tsx"), "utf8");
		expect(widget).toContain("callTool");
		expect(widget).toContain("my-panel__save");
		expect(widget).not.toContain("fetch(");
	});
});

// ── parseArgs ──────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
	it("defaults to the agent template", () => {
		expect(parseArgs(["my-app"])).toEqual({
			name: "my-app",
			template: "agent",
		});
	});

	it("accepts --template <value>", () => {
		expect(parseArgs(["my-app", "--template", "ryu-app"])).toEqual({
			name: "my-app",
			template: "ryu-app",
		});
	});

	it("accepts --template=<value>", () => {
		expect(parseArgs(["my-app", "--template=hook-plugin"])).toEqual({
			name: "my-app",
			template: "hook-plugin",
		});
	});

	it("rejects a second positional argument", () => {
		const result = parseArgs(["a", "b"]);
		expect("error" in result).toBe(true);
	});

	it("rejects an unknown flag", () => {
		const result = parseArgs(["a", "--nope"]);
		expect("error" in result).toBe(true);
	});
});
