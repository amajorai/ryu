/**
 * Ryu App authoring factory — `defineApp`.
 *
 * A "Ryu App" bundles one or more tools whose results render an interactive
 * widget inline in chat (the ChatGPT-Apps-style surface). `defineApp` assembles a
 * complete `plugin.json` `PluginManifest` from a declarative description, deriving
 * the render-vs-companion split exactly the way Core's in-process provider does
 * (`apps/core/src/sidecar/mcp/apps/mod.rs` `tools()`):
 *
 *   - A **render** tool (`accessible` unset/false) produces the widget: it gets a
 *     `contributes.widgets[]` entry binding its id to the app's
 *     `ui://widget/<slug>.html` template, and its runnable config carries
 *     `widget:true` plus `invoking`/`invoked` status labels.
 *   - A **companion** tool (`accessible:true`) is a call target a mounted widget
 *     may invoke: it carries `widget_accessible:true` and gets no widget template.
 *
 * v1 boundary: this is **declarative pass-through only** — there is no `run`
 * handler. Third-party tool code execution needs the plugin runtime (out of
 * scope); the widget renders from `window.openai.toolInput`/`toolOutput` and Core
 * echoes the validated arguments as `structuredContent`. `ryu pack` bundles the
 * `uiEntry` source into the manifest's `ui_code`.
 */

import type {
	Contributes,
	PluginManifest,
	RunnableMeta,
	ToolAppConfig,
	WidgetContribution,
} from "../manifest.ts";
import { PluginManifestSchema } from "../manifest.ts";

/** The default widget MIME dialect (mirrors Core `default_widget_mime`). */
const DEFAULT_APP_WIDGET_MIME = "text/html+skybridge";
/** The default widget display mode (mirrors Core `default_widget_display_mode`). */
const DEFAULT_APP_DISPLAY_MODE = "inline";

/** One tool a Ryu App declares. */
export interface AppToolSpec {
	/**
	 * True when this is a **companion** tool — a call target a mounted widget may
	 * `callTool`. False/unset makes it a **render** tool that produces the widget.
	 */
	accessible?: boolean;
	/** Human-readable description the model reads when choosing the tool. */
	description: string;
	/** JSON Schema object describing the tool's arguments. Optional. */
	inputSchema?: Record<string, unknown>;
	/** Status label shown when a render tool finishes (e.g. `"Chart ready"`). */
	invoked?: string;
	/** Status label shown while a render tool runs (e.g. `"Plotting chart…"`). */
	invoking?: string;
	/** Tool name (unqualified). The wire id is `<server>__<name>`. */
	name: string;
}

/** Options for {@link defineApp}. */
export interface DefineAppOptions {
	/** VS-Code-style activation events. Empty = eager (default `["*"]`). */
	activationEvents?: string[];
	/** Default widget display mode (`inline` | `fullscreen` | `pip`). */
	displayMode?: string;
	/** Permission grants the app declares it needs (e.g. `["mcp:web_search"]`). */
	grants?: string[];
	/** Reverse-domain plugin id (e.g. `"com.example.checklist"`). */
	id: string;
	/** Widget MIME dialect. Defaults to `text/html+skybridge`. */
	mime?: string;
	/** MCP server namespace for the tool ids. Defaults to `slug`. */
	server?: string;
	/**
	 * App slug — used to build the widget uri (`ui://widget/<slug>.html`) and, when
	 * `server` is omitted, the MCP server namespace that qualifies each tool id.
	 */
	slug: string;
	/** Human-readable display name shown in the app store / launcher. */
	title: string;
	/** The tools this app exposes (at least one render tool is expected). */
	tools: AppToolSpec[];
	/**
	 * Source entry (relative to the manifest dir) for the widget UI. `ryu pack`
	 * bundles it into the manifest's `ui_code` so Core can serve the widget HTML.
	 */
	uiEntry: string;
	/** Semver version string (e.g. `"1.0.0"`). */
	version: string;
}

/** Build a fully-qualified tool id from a server namespace and tool name. */
export function appToolId(server: string, name: string): string {
	return `${server}__${name}`;
}

/**
 * Assemble a `plugin.json` manifest for a Ryu App. The result matches Core's
 * `PluginManifest` serde shape (validated through `PluginManifestSchema`) and can
 * be written to disk, packed with `ryu pack`, or published with `ryu publish`.
 *
 * @example
 * ```ts
 * import { defineApp } from "@ryuhq/sdk"
 *
 * const manifest = defineApp({
 *   id: "com.example.checklist",
 *   title: "Checklist",
 *   version: "1.0.0",
 *   slug: "checklist",
 *   uiEntry: "src/checklist.tsx",
 *   tools: [
 *     { name: "render", description: "Render a checklist", invoking: "Building…", invoked: "Ready" },
 *     { name: "toggle", description: "Toggle an item", accessible: true },
 *   ],
 * })
 * ```
 */
export function defineApp(options: DefineAppOptions): PluginManifest {
	const server = options.server ?? options.slug;
	const uri = `ui://widget/${options.slug}.html`;
	const mime = options.mime ?? DEFAULT_APP_WIDGET_MIME;
	const displayMode = options.displayMode ?? DEFAULT_APP_DISPLAY_MODE;
	// Whether the app declares any companion tool. A render tool's widget may call
	// tools only when the app has at least one companion — mirrors `has_companions`
	// in Core's `apps::tools()`.
	const hasCompanions = options.tools.some((t) => t.accessible === true);

	const runnables: RunnableMeta[] = [];
	const widgets: WidgetContribution[] = [];

	for (const spec of options.tools) {
		const isRender = spec.accessible !== true;
		const id = appToolId(server, spec.name);

		const config: ToolAppConfig = {
			slug: id,
			description: spec.description,
			widget: isRender,
			widget_accessible: isRender ? hasCompanions : true,
			...(spec.inputSchema ? { input_schema: spec.inputSchema } : {}),
			...(spec.invoking ? { invoking: spec.invoking } : {}),
			...(spec.invoked ? { invoked: spec.invoked } : {}),
		};

		runnables.push({
			id,
			name: spec.name,
			kind: "tool",
			config,
		});

		if (isRender) {
			widgets.push({
				tool_id: id,
				uri,
				ui_entry: options.uiEntry,
				mime,
				default_display_mode: displayMode,
			});
		}
	}

	const contributes: Contributes = {
		turn_hooks: [],
		composer_controls: [],
		settings_tabs: [],
		slash_commands: [],
		widgets,
	};

	const raw = {
		id: options.id,
		name: options.title,
		version: options.version,
		runnables,
		permission_grants: options.grants ?? [],
		activation_events: options.activationEvents ?? ["*"],
		contributes,
	};

	const result = PluginManifestSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const message = first?.message ?? "validation failed";
		throw new Error(`plugin.json validation failed at '${field}': ${message}`);
	}
	return result.data;
}
