/**
 * create-ryu-app scaffold test.
 *
 * The native addon is mocked in test-preload.ts (bunfig.toml) so the zod
 * PluginManifestSchema — the gate this suite exercises — loads without the
 * `@ryuhq/sdk-native` binary.
 *
 * Asserts, for every template:
 *   1. The scaffold produces the expected file set.
 *   2. The generated manifest.json parses against PluginManifestSchema.
 *   3. The manifest has the shape that template promises (agent runnable /
 *      turn hook / widget / companion tool + surface / sidecar + capability).
 *   4. The authoring src uses the matching defineX factory, and — for the widget
 *      templates — the factory output deep-equals the shipped manifest.json, proving
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
	const raw = readFileSync(join(projectDir, "manifest.json"), "utf8");
	return PluginManifestSchema.parse(JSON.parse(raw));
}

/**
 * The manifest exactly as it sits on disk.
 *
 * `readManifest` must NOT be used for the satellite blocks: `PluginManifestSchema`
 * is a non-strict `z.object`, so it accepts `sidecars`/`provides`/`engines` and
 * then STRIPS them from the parsed value. Core's Rust loader is the authority on
 * those, and it reads the bytes — so the assertions about them read the bytes too.
 */
function readRawManifest(projectDir: string): Record<string, unknown> {
	const raw = readFileSync(join(projectDir, "manifest.json"), "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
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
		for (const file of ["manifest.json", "src/agent.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("manifest.json parses against PluginManifestSchema", () => {
		expect(() => readManifest(projectDir)).not.toThrow();
	});

	it("manifest.json contains the correct plugin id slug and name", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-test-app");
		expect(parsed.name).toBe("My Test App");
	});

	it("manifest.json companion label matches display name", () => {
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
		expect(pkg.dependencies["@ryuhq/sdk"]).toBe("^0.2.6");
	});

	it("manifest.json has at least one agent runnable", () => {
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

// ── action template ──────────────────────────────────────────────────────────

describe("create-ryu-app scaffold (action)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-action-${Date.now()}`);
		projectDir = scaffold("my-action", tmpDir, "action");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces an action source, manifest, and package", () => {
		for (const file of ["manifest.json", "src/action.ts", "package.json"]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
	});

	it("declares a governed action with structured output and approval", () => {
		const parsed = readManifest(projectDir);
		const action = parsed.runnables.find((r) => r.id === "action-main");
		expect(action).toMatchObject({
			name: "Main Action",
			kind: "tool",
		});
		expect(action?.config).toMatchObject({
			action: true,
			backend: "inline_deno",
			needs_approval: true,
			annotations: {
				destructiveHint: true,
				readOnlyHint: false,
			},
		});
		expect(action?.config?.output_schema).toBeDefined();
	});

	it("source uses defineAction from the public SDK", () => {
		const src = readFileSync(join(projectDir, "src/action.ts"), "utf8");
		expect(src).toContain('import { defineAction } from "@ryuhq/sdk"');
		expect(src).toContain("needsApproval: true");
		expect(src).toContain('effect: "mutate"');
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
		for (const file of ["manifest.json", "src/plugin.ts", "package.json"]) {
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
			"manifest.json",
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
		expect(widgets[0]?.tool_id).toBe("my-widget.render");
		const render = parsed.runnables.find((r) => r.id === "my-widget.render");
		expect(render?.kind).toBe("tool");
		expect((render?.config as { widget?: boolean })?.widget).toBe(true);
	});

	it("stamped src/app.ts defineApp output deep-equals the shipped manifest.json", async () => {
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
		const save = parsed.runnables.find((r) => r.id === "my-panel.save");
		expect(save).toBeDefined();
		expect(
			(save?.config as { widget_accessible?: boolean })?.widget_accessible
		).toBe(true);
		// The render tool's widget may call companions because one exists.
		const render = parsed.runnables.find((r) => r.id === "my-panel.render");
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

	it("stamped src/app.ts defineApp output deep-equals the shipped manifest.json", async () => {
		const mod = (await import(join(projectDir, "src/app.ts"))) as {
			default: unknown;
		};
		expect(mod.default).toEqual(readManifest(projectDir));
	});

	it("the widget calls the companion tool via the host bridge", () => {
		const widget = readFileSync(join(projectDir, "src/widget.tsx"), "utf8");
		expect(widget).toContain("callTool");
		expect(widget).toContain("my-panel.save");
		expect(widget).not.toContain("fetch(");
	});
});

// ── app template (an apps-store satellite, NOT a plugin) ──────────────────────

/** The satellite blocks, as they sit on disk. Mirrors `SidecarSpec` /
 *  `ProvidesEntry` in `crates/core/kernel-contracts` — the Rust loader that
 *  cross-validates them is what these assertions stand in for, since a TS suite
 *  cannot run it. */
interface RawSidecar {
	health_path: string;
	http?: { routes?: Array<{ path: string }> };
	idle_stop_secs?: number;
	lazy?: boolean;
	name: string;
	port: number;
	process: {
		kind: string;
		command: string;
		command_env?: string;
		port_env?: string;
	};
}

interface RawProvides {
	capability: string;
	grant?: string;
	route?: string;
	sidecar?: string;
	version: string;
}

/** The slice of the generated sidecar's control module this suite drives. */
interface ControlModule {
	CAPABILITY: string;
	handleRequest(
		method: string,
		path: string,
		authHeader: string | undefined,
		body: string,
		deps: { store: unknown; token: string | null }
	): { status: number; json?: unknown };
	MemoryItemStore: new () => unknown;
	resolveControlPort(env: Record<string, string | undefined>): number;
	resolveControlToken(env: Record<string, string | undefined>): string | null;
}

describe("create-ryu-app scaffold (app)", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `__test-app-${Date.now()}`);
		projectDir = scaffold("my-app", tmpDir, "app");
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("produces a satellite tree: a manifest plus a self-contained sidecar/", () => {
		for (const file of [
			"manifest.json",
			"README.md",
			"package.json",
			"sidecar/package.json",
			"sidecar/tsconfig.json",
			"sidecar/src/main/index.ts",
			"sidecar/src/main/control.ts",
		]) {
			expect(existsSync(join(projectDir, file))).toBe(true);
		}
		// An app is NOT a plugin: no authoring src/, no widget, no packed UI.
		expect(existsSync(join(projectDir, "src"))).toBe(false);
	});

	it("manifest.json still parses against PluginManifestSchema", () => {
		const parsed = readManifest(projectDir);
		expect(parsed.id).toBe("com.example.my-app");
		expect(parsed.name).toBe("My App");
		// A satellite contributes nothing in-process — no widgets, no hooks, no
		// settings tabs, no tool filters — so it declares no `contributes` block at
		// all and cannot contradict those typed contracts.
		expect(parsed.contributes).toBeUndefined();
		expect(parsed.runnables).toHaveLength(0);
	});

	it("declares a lazy local sidecar wired to the injected env vars", () => {
		const raw = readRawManifest(projectDir);
		const sidecars = raw.sidecars as RawSidecar[];
		expect(sidecars).toHaveLength(1);
		const sidecar = sidecars[0];
		expect(sidecar?.name).toBe("my-app");
		expect(sidecar?.process.kind).toBe("local");
		expect(sidecar?.process.command).toBe("ryu-my-app");
		// The env names are stamped from the slug; `port_env` is what lets a
		// dev-profile Core hand the child its profile-shifted port.
		expect(sidecar?.process.command_env).toBe("RYU_MY_APP_BIN");
		expect(sidecar?.process.port_env).toBe("RYU_MY_APP_PORT");
		expect(sidecar?.health_path).toBe("/health");
		expect(sidecar?.lazy).toBe(true);
		expect(sidecar?.idle_stop_secs).toBeGreaterThanOrEqual(30);
	});

	it("provides[] cross-validates against the sidecar it names", () => {
		const raw = readRawManifest(projectDir);
		const sidecar = (raw.sidecars as RawSidecar[])[0];
		const provides = raw.provides as RawProvides[];
		expect(provides).toHaveLength(1);
		const entry = provides[0];
		expect(entry?.capability).toBe("my-app.control");
		// Core's loader rejects a provides entry whose sidecar/route does not exist.
		expect(entry?.sidecar).toBe(sidecar?.name);
		const routes = (sidecar?.http?.routes ?? []).map((r) => r.path);
		expect(routes).toContain(entry?.route);
		// The grant the capability is gated behind must be one the app declares.
		expect(raw.permission_grants as string[]).toContain(entry?.grant);
	});

	it("leaves no unstamped placeholder anywhere in the tree", () => {
		for (const file of [
			"manifest.json",
			"README.md",
			"sidecar/package.json",
			"sidecar/src/main/index.ts",
			"sidecar/src/main/control.ts",
		]) {
			const src = readFileSync(join(projectDir, file), "utf8");
			expect(src).not.toContain("__APP_");
		}
	});

	it("package.json runs the sidecar and depends on nothing of ours", () => {
		const pkg = JSON.parse(
			readFileSync(join(projectDir, "package.json"), "utf8")
		) as {
			scripts: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		expect(pkg.scripts.dev).toBe("bun run sidecar/src/main/index.ts");
		expect(pkg.scripts.build).toBe("bun run --cwd sidecar build");
		// A satellite must ship from its own tree: no @ryuhq/sdk, and no `ryu pack`
		// (there is no widget bundle to pack).
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.scripts.pack).toBeUndefined();
	});

	it("the sidecar's own package.json names the binary the manifest spawns", () => {
		const raw = readRawManifest(projectDir);
		const command = (raw.sidecars as RawSidecar[])[0]?.process.command;
		const pkg = JSON.parse(
			readFileSync(join(projectDir, "sidecar/package.json"), "utf8")
		) as { bin: Record<string, string>; dependencies?: Record<string, string> };
		expect(Object.keys(pkg.bin)).toContain(command);
		// Dependency-free by design (node:http + node:crypto only).
		expect(pkg.dependencies).toBeUndefined();
	});

	it("the sidecar serves every route the manifest declares", async () => {
		const control = (await import(
			join(projectDir, "sidecar/src/main/control.ts")
		)) as unknown as ControlModule;
		const deps = { store: new control.MemoryItemStore(), token: "tok" };
		const auth = "Bearer tok";

		// `/health` — the health_path Core probes, deliberately unauthenticated.
		expect(
			control.handleRequest("GET", "/health", undefined, "", deps).status
		).toBe(200);

		// `/` — the capability root `provides[].route` points at.
		const root = control.handleRequest("GET", "/", auth, "", deps);
		expect(root.status).toBe(200);
		expect((root.json as { capability: string }).capability).toBe(
			control.CAPABILITY
		);

		// `/items` + `/items/:id` — the declared collection and item routes.
		expect(control.handleRequest("GET", "/items", auth, "", deps).status).toBe(
			200
		);
		const created = control.handleRequest(
			"POST",
			"/items",
			auth,
			JSON.stringify({ text: "hello" }),
			deps
		);
		expect(created.status).toBe(201);
		const id = (created.json as { item: { id: string } }).item.id;
		expect(
			control.handleRequest("GET", `/items/${id}`, auth, "", deps).status
		).toBe(200);
		expect(
			control.handleRequest("DELETE", `/items/${id}`, auth, "", deps).status
		).toBe(200);
	});

	it("the sidecar fails closed when no token is injected", async () => {
		const control = (await import(
			join(projectDir, "sidecar/src/main/control.ts")
		)) as unknown as ControlModule;
		const store = new control.MemoryItemStore();

		// No token configured ⇒ every protected route 401s, even with a bearer.
		expect(control.resolveControlToken({})).toBeNull();
		const closed = { store, token: null };
		expect(
			control.handleRequest("GET", "/items", "Bearer x", "", closed).status
		).toBe(401);
		// …but health stays reachable so Core can still see the process is alive.
		expect(
			control.handleRequest("GET", "/health", undefined, "", closed).status
		).toBe(200);

		// A token IS configured but the caller presents none/the wrong one ⇒ 401.
		const open = { store, token: "tok" };
		expect(
			control.handleRequest("GET", "/items", undefined, "", open).status
		).toBe(401);
		expect(
			control.handleRequest("GET", "/items", "Bearer nope", "", open).status
		).toBe(401);
	});

	it("the sidecar reads its bind port from the injected env var", async () => {
		const control = (await import(
			join(projectDir, "sidecar/src/main/control.ts")
		)) as unknown as ControlModule;
		const raw = readRawManifest(projectDir);
		const sidecar = (raw.sidecars as RawSidecar[])[0];

		// Core injects the profile-shifted port under `port_env`; honouring it is
		// what keeps a dev-profile node from health-checking a port the child never
		// bound.
		expect(control.resolveControlPort({ RYU_MY_APP_PORT: "9123" })).toBe(9123);
		expect(control.resolveControlPort({})).toBe(sidecar?.port);
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

	it("accepts the app template alongside the plugin ones", () => {
		expect(parseArgs(["my-app", "--template", "app"])).toEqual({
			name: "my-app",
			template: "app",
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

	it("errors when --template is given without a value", () => {
		const result = parseArgs(["my-app", "--template"]);
		expect(result).toEqual({ error: "--template requires a value" });
	});

	it("treats a trailing --template=<empty> as an empty template string", () => {
		// The scaffold gate (not parseArgs) rejects an unknown template; parseArgs
		// only splits on the first '=', so an empty value parses through as "".
		expect(parseArgs(["my-app", "--template="])).toEqual({
			name: "my-app",
			template: "",
		});
	});

	it("--template before the name still binds both positionally", () => {
		expect(parseArgs(["--template", "ryu-app", "my-app"])).toEqual({
			name: "my-app",
			template: "ryu-app",
		});
	});

	it("returns an undefined name when no positional is given", () => {
		expect(parseArgs(["--template", "agent"])).toEqual({
			name: undefined,
			template: "agent",
		});
	});

	it("reports the unknown flag's exact name in the error", () => {
		const result = parseArgs(["my-app", "--verbose"]);
		expect(result).toEqual({ error: "unknown option: --verbose" });
	});
});
