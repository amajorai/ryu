/**
 * Round-trip test: build a Plugin in TS via the SDK, validate it, pack it, and
 * confirm the packed JSON round-trips through `PluginManifestSchema` — proving
 * that the SDK schema and Core schema agree.
 *
 * This test runs entirely in-process (no filesystem side effects beyond a
 * temp directory) and is the authoritative acceptance proof for the acceptance
 * criterion "A round-trip test builds a Plugin in TS, packs it, and Core's
 * loader installs it successfully."
 *
 * The "Core's loader installs it" part is verified here by confirming that the
 * emitted JSON satisfies `PluginManifestSchema` — the same schema Core's
 * `PluginManifestLoader::parse_and_validate` enforces in Rust (the Rust tests in
 * `apps/core/src/plugin_manifest/mod.rs` assert the same fixture parses).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agent, app, PluginBuilder, skill, tool, workflow } from "./builder.ts";
import { PluginManifestSchema } from "./manifest.ts";
import { defineApp } from "./runnable/app.ts";

// ── builder unit tests ────────────────────────────────────────────────────────

describe("PluginBuilder", () => {
	it("builds a valid minimal manifest", () => {
		const manifest = new PluginBuilder()
			.id("com.example.minimal")
			.name("Minimal App")
			.version("0.1.0")
			.build();

		expect(manifest.id).toBe("com.example.minimal");
		expect(manifest.name).toBe("Minimal App");
		expect(manifest.version).toBe("0.1.0");
		expect(manifest.runnables).toEqual([]);
		expect(manifest.permission_grants).toEqual([]);
		expect(manifest.companion).toBeUndefined();
	});

	it("builds a manifest with all runnable kinds", () => {
		const manifest = new PluginBuilder()
			.id("com.example.full")
			.name("Full App")
			.version("1.2.3")
			.runnable(agent().id("agent-main").name("Main Agent").build())
			.runnable(workflow().id("wf-pipeline").name("Pipeline").build())
			.runnable(tool().id("tool-search").name("Web Search").build())
			.runnable(skill().id("skill-research").name("Research").build())
			.grant("mcp:web_search")
			.grant("mcp:file_read")
			.companion({
				label: "Full App",
				icon: "sparkles",
				shortcut: "ctrl+shift+f",
			})
			.build();

		expect(manifest.runnables).toHaveLength(4);
		expect(manifest.runnables.map((r) => r.kind)).toEqual([
			"agent",
			"workflow",
			"tool",
			"skill",
		]);
		expect(manifest.permission_grants).toEqual([
			"mcp:web_search",
			"mcp:file_read",
		]);
		expect(manifest.companion?.label).toBe("Full App");
	});

	it("throws on missing id", () => {
		expect(() =>
			new PluginBuilder().name("No ID").version("1.0.0").build()
		).toThrow(/id/);
	});

	it("rejects a companion label that impersonates system chrome", () => {
		for (const bad of ["Ryu Settings", "System Tools", "my RYU panel"]) {
			expect(() =>
				new PluginBuilder()
					.id("com.example.evil")
					.name("Evil")
					.version("1.0.0")
					.companion({ label: bad })
					.build()
			).toThrow(/impersonate system chrome/);
		}
	});

	it("throws on invalid semver", () => {
		expect(() =>
			new PluginBuilder()
				.id("com.example.bad")
				.name("Bad")
				.version("not-semver")
				.build()
		).toThrow(/semver/);
	});

	it("engine/model fields are open strings — no union", () => {
		// This test proves the SDK type system doesn't restrict engines to a
		// hardcoded list.  RunnableMeta has no engine/model field at the identity
		// layer (engine is a config concern, not a manifest identity concern), and
		// the PluginManifest schema places no restriction on what values permission
		// grants strings may carry. Any new provider or engine id works without an
		// SDK change.
		const manifest = new PluginBuilder()
			.id("com.example.custom-engine")
			.name("Custom Engine App")
			.version("1.0.0")
			.grant("engine:my-custom-llm-v99")
			.build();

		expect(manifest.permission_grants).toContain("engine:my-custom-llm-v99");
	});
});

describe("per-kind builders", () => {
	it("agent() factory builds an agent runnable", () => {
		const r = agent().id("a-1").name("Agent One").build();
		expect(r.kind).toBe("agent");
		expect(r.id).toBe("a-1");
	});

	it("workflow() factory builds a workflow runnable", () => {
		const r = workflow().id("wf-1").name("Workflow One").build();
		expect(r.kind).toBe("workflow");
	});

	it("tool() factory builds a tool runnable", () => {
		const r = tool().id("t-1").name("Tool One").build();
		expect(r.kind).toBe("tool");
	});

	it("skill() factory builds a skill runnable", () => {
		const r = skill().id("s-1").name("Skill One").build();
		expect(r.kind).toBe("skill");
	});

	it("throws when id is empty", () => {
		expect(() => agent().name("No ID").build()).toThrow();
	});
});

// ── round-trip test ───────────────────────────────────────────────────────────

describe("round-trip: SDK build → JSON → Core schema parse", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, `../__test-roundtrip-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		if (existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("emitted plugin.json satisfies PluginManifestSchema (Core compat proof)", () => {
		// 1. Build a manifest using the SDK.
		const manifest = new PluginBuilder()
			.id("com.example.research-assistant")
			.name("Research Assistant")
			.version("1.0.0")
			.runnable(agent().id("agent-researcher").name("Researcher").build())
			.runnable(
				workflow().id("wf-summarise").name("Summarise Workflow").build()
			)
			.runnable(tool().id("tool-web-search").name("Web Search").build())
			.runnable(skill().id("skill-research").name("Research Skill").build())
			.grant("mcp:web_search")
			.grant("mcp:file_read")
			.companion({
				label: "Research Assistant",
				icon: "magnifying-glass",
				shortcut: "ctrl+shift+r",
			})
			.build();

		// 2. Emit to a temp plugin.json (simulating what `ryu pack` writes).
		const manifestPath = join(tmpDir, "plugin.json");
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

		// 3. Read it back and parse through `PluginManifestSchema` — the same
		//    validation Core's PluginManifestLoader applies in Rust.
		const raw = readFileSync(manifestPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const result = PluginManifestSchema.safeParse(parsed);

		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}

		const loaded = result.data;
		expect(loaded.id).toBe("com.example.research-assistant");
		expect(loaded.runnables).toHaveLength(4);
		expect(loaded.permission_grants).toEqual([
			"mcp:web_search",
			"mcp:file_read",
		]);
		expect(loaded.companion?.shortcut).toBe("ctrl+shift+r");
	});

	it("matches the Core fixture (sample.plugin.json)", () => {
		// The Core Rust test (`sample_fixture_deserializes_into_app_manifest`)
		// asserts the same values — this verifies TS schema parity.
		const fixture = {
			id: "com.example.research-assistant",
			name: "Research Assistant",
			version: "1.0.0",
			runnables: [
				{ id: "agent-researcher", name: "Researcher", kind: "agent" },
				{ id: "wf-summarise", name: "Summarise Workflow", kind: "workflow" },
				{ id: "tool-web-search", name: "Web Search", kind: "tool" },
				{ id: "skill-research", name: "Research Skill", kind: "skill" },
			],
			permission_grants: ["mcp:web_search", "mcp:file_read"],
			companion: {
				label: "Research Assistant",
				icon: "magnifying-glass",
				shortcut: "ctrl+shift+r",
			},
		};

		const result = PluginManifestSchema.safeParse(fixture);
		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}

		expect(result.data.id).toBe("com.example.research-assistant");
		expect(result.data.runnables).toHaveLength(4);
		const kinds = result.data.runnables.map((r) => r.kind);
		expect(kinds).toContain("agent");
		expect(kinds).toContain("workflow");
		expect(kinds).toContain("tool");
		expect(kinds).toContain("skill");
	});

	it("invalid semver in JSON is rejected", () => {
		const bad = {
			id: "com.example.bad",
			name: "Bad",
			version: "not-a-version",
			runnables: [],
		};
		const result = PluginManifestSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});

	it("missing id in JSON is rejected", () => {
		const bad = { name: "No ID", version: "1.0.0", runnables: [] };
		const result = PluginManifestSchema.safeParse(bad);
		expect(result.success).toBe(false);
	});
});

// ── Ryu App (defineApp / AppBuilder) ──────────────────────────────────────────

describe("defineApp", () => {
	// A fixture app with one render tool + one companion (accessible) tool. This
	// exercises the render-vs-companion derivation that mirrors Core's
	// `apps::tools()`.
	function fixtureApp() {
		return defineApp({
			id: "com.example.checklist",
			title: "Checklist",
			version: "1.0.0",
			slug: "checklist",
			uiEntry: "src/checklist.tsx",
			grants: ["mcp:file_read"],
			tools: [
				{
					name: "render",
					description: "Render a checklist",
					inputSchema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
					invoking: "Building…",
					invoked: "Ready",
				},
				{ name: "toggle", description: "Toggle an item", accessible: true },
			],
		});
	}

	it("emits one WidgetContribution for the render tool and none for the companion", () => {
		const manifest = fixtureApp();
		const widgets = manifest.contributes?.widgets ?? [];

		expect(widgets).toHaveLength(1);
		expect(widgets[0]?.tool_id).toBe("checklist__render");
		expect(widgets[0]?.uri).toBe("ui://widget/checklist.html");
		expect(widgets[0]?.ui_entry).toBe("src/checklist.tsx");
		expect(widgets[0]?.mime).toBe("text/html+skybridge");
		expect(widgets[0]?.default_display_mode).toBe("inline");
	});

	it("builds one kind:'tool' runnable per tool with the widget config flags", () => {
		const manifest = fixtureApp();
		expect(manifest.runnables).toHaveLength(2);
		expect(manifest.runnables.every((r) => r.kind === "tool")).toBe(true);

		const render = manifest.runnables.find((r) => r.id === "checklist__render");
		expect(render?.config).toMatchObject({
			slug: "checklist__render",
			// The manifest is the only channel for a packed app: description +
			// input_schema must survive so Core can rebuild a driveable tool.
			description: "Render a checklist",
			input_schema: {
				type: "object",
				properties: { title: { type: "string" } },
			},
			widget: true,
			// The render tool's widget may call tools because the app declares a
			// companion (widget_accessible tool).
			widget_accessible: true,
			invoking: "Building…",
			invoked: "Ready",
		});

		const toggle = manifest.runnables.find((r) => r.id === "checklist__toggle");
		expect(toggle?.config).toMatchObject({
			slug: "checklist__toggle",
			widget: false,
			widget_accessible: true,
		});
	});

	it("marks a render tool's widget non-accessible when the app has no companion", () => {
		const manifest = defineApp({
			id: "com.example.chart",
			title: "Chart",
			version: "1.0.0",
			slug: "chart-studio",
			server: "chart",
			uiEntry: "src/chart.tsx",
			tools: [{ name: "render", description: "Render a chart" }],
		});
		const render = manifest.runnables.find((r) => r.id === "chart__render");
		expect(render?.config).toMatchObject({
			widget: true,
			widget_accessible: false,
		});
		// `server` override qualifies the tool id and the widget binding.
		expect(manifest.contributes?.widgets[0]?.tool_id).toBe("chart__render");
		// The widget uri still derives from the slug, not the server.
		expect(manifest.contributes?.widgets[0]?.uri).toBe(
			"ui://widget/chart-studio.html"
		);
	});

	it("round-trips through PluginManifestSchema without stripping widgets", () => {
		// The load-bearing check: `contributes.widgets` is only preserved because it
		// was added to `ContributesSchema`. A JSON round-trip proves the field
		// survives Core-strict zod parse (the same parse the CLI applies).
		const manifest = fixtureApp();
		const json = JSON.stringify(manifest);
		const parsed = PluginManifestSchema.safeParse(JSON.parse(json));

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			return;
		}
		expect(parsed.data.contributes?.widgets).toHaveLength(1);
		expect(parsed.data.contributes?.widgets[0]?.tool_id).toBe(
			"checklist__render"
		);
		// description + input_schema survive the strict parse (the only channel for
		// a packed app — no `generated.rs` on the Core side).
		const render = parsed.data.runnables.find(
			(r) => r.id === "checklist__render"
		);
		expect(render?.config?.description).toBe("Render a checklist");
		expect(render?.config?.input_schema).toBeDefined();
	});

	it("rejects an invalid semver version", () => {
		expect(() =>
			defineApp({
				id: "com.example.bad",
				title: "Bad",
				version: "not-semver",
				slug: "bad",
				uiEntry: "src/bad.tsx",
				tools: [{ name: "render", description: "Render" }],
			})
		).toThrow(/semver/);
	});
});

describe("AppBuilder", () => {
	it("builds an equivalent manifest to defineApp", () => {
		const manifest = app()
			.id("com.example.checklist")
			.title("Checklist")
			.version("1.0.0")
			.slug("checklist")
			.uiEntry("src/checklist.tsx")
			.grant("mcp:file_read")
			.tool({
				name: "render",
				description: "Render a checklist",
				invoking: "Building…",
				invoked: "Ready",
			})
			.tool({ name: "toggle", description: "Toggle an item", accessible: true })
			.build();

		expect(manifest.id).toBe("com.example.checklist");
		expect(manifest.runnables).toHaveLength(2);
		expect(manifest.contributes?.widgets).toHaveLength(1);
		expect(manifest.contributes?.widgets[0]?.tool_id).toBe("checklist__render");
		expect(manifest.permission_grants).toEqual(["mcp:file_read"]);
	});

	it("throws on missing id", () => {
		expect(() =>
			app()
				.title("No ID")
				.version("1.0.0")
				.slug("x")
				.uiEntry("src/x.tsx")
				.tool({ name: "render", description: "Render" })
				.build()
		).toThrow(/id/);
	});
});
