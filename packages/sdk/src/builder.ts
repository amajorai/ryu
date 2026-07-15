/**
 * Ryu SDK typed builders — one builder per RunnableKind plus a PluginBuilder that
 * assembles a complete, validated `plugin.json` manifest.
 *
 * Each builder follows a fluent interface: construct, chain setter calls, then
 * call `.build()` to get a validated result. Invalid manifests throw a
 * descriptive `Error` — never a silent fallback.
 *
 * Engine/model fields are typed as `string` throughout.  No provider union is
 * used so adding a new provider never requires an SDK change.
 */

import type {
	AppDependency,
	CompanionSurface,
	PluginManifest,
	RunnableMeta,
	Surface,
} from "./manifest.ts";
import { PluginManifestSchema, RunnableMetaSchema } from "./manifest.ts";
import type { AppToolSpec, DefineAppOptions } from "./runnable/app.ts";
import { defineApp } from "./runnable/app.ts";

// ── RunnableMeta builders ─────────────────────────────────────────────────────

/** Base builder shared by all Runnable kinds. */
class RunnableBuilder {
	protected _id = "";
	protected _name = "";

	id(value: string): this {
		this._id = value;
		return this;
	}

	name(value: string): this {
		this._name = value;
		return this;
	}
}

/** Builds an Agent `RunnableMeta` entry. */
export class AgentBuilder extends RunnableBuilder {
	build(): RunnableMeta {
		const result = RunnableMetaSchema.safeParse({
			id: this._id,
			name: this._name,
			kind: "agent",
		});
		if (!result.success) {
			throw new Error(
				`Invalid agent runnable: ${result.error.issues.map((i) => i.message).join("; ")}`
			);
		}
		return result.data;
	}
}

/** Builds a Workflow `RunnableMeta` entry. */
export class WorkflowBuilder extends RunnableBuilder {
	build(): RunnableMeta {
		const result = RunnableMetaSchema.safeParse({
			id: this._id,
			name: this._name,
			kind: "workflow",
		});
		if (!result.success) {
			throw new Error(
				`Invalid workflow runnable: ${result.error.issues.map((i) => i.message).join("; ")}`
			);
		}
		return result.data;
	}
}

/** Builds a Tool `RunnableMeta` entry. */
export class ToolBuilder extends RunnableBuilder {
	build(): RunnableMeta {
		const result = RunnableMetaSchema.safeParse({
			id: this._id,
			name: this._name,
			kind: "tool",
		});
		if (!result.success) {
			throw new Error(
				`Invalid tool runnable: ${result.error.issues.map((i) => i.message).join("; ")}`
			);
		}
		return result.data;
	}
}

/** Builds a Skill `RunnableMeta` entry. */
export class SkillBuilder extends RunnableBuilder {
	build(): RunnableMeta {
		const result = RunnableMetaSchema.safeParse({
			id: this._id,
			name: this._name,
			kind: "skill",
		});
		if (!result.success) {
			throw new Error(
				`Invalid skill runnable: ${result.error.issues.map((i) => i.message).join("; ")}`
			);
		}
		return result.data;
	}
}

// ── Convenience factory functions ─────────────────────────────────────────────

/** Create an AgentBuilder. */
export const agent = () => new AgentBuilder();

/** Create a WorkflowBuilder. */
export const workflow = () => new WorkflowBuilder();

/** Create a ToolBuilder. */
export const tool = () => new ToolBuilder();

/** Create a SkillBuilder. */
export const skill = () => new SkillBuilder();

// ── PluginBuilder ─────────────────────────────────────────────────────────────

/**
 * Fluent builder for a complete `plugin.json` Plugin manifest. Produces a
 * validated `PluginManifest` on `.build()` or throws a descriptive `Error`
 * naming the first invalid field.
 *
 * @example
 * ```ts
 * import { PluginBuilder, agent, tool } from "@ryuhq/sdk/builder"
 *
 * const manifest = new PluginBuilder()
 *   .id("com.example.my-plugin")
 *   .name("My Plugin")
 *   .version("1.0.0")
 *   .runnable(agent().id("agent-main").name("Main Agent").build())
 *   .runnable(tool().id("tool-search").name("Web Search").build())
 *   .grant("mcp:web_search")
 *   .companion({ label: "My Plugin", icon: "sparkles", shortcut: "ctrl+shift+m" })
 *   .build()
 * ```
 */
export class PluginBuilder {
	private _id = "";
	private _name = "";
	private _version = "";
	private readonly _runnables: RunnableMeta[] = [];
	private readonly _grants: string[] = [];
	private _companion: CompanionSurface | undefined = undefined;
	private readonly _dependencies: AppDependency[] = [];
	private readonly _requiredGrants: string[] = [];
	private readonly _targets: Surface[] = [];

	/** Set the reverse-domain app id (e.g. `"com.example.my-app"`). */
	id(value: string): this {
		this._id = value;
		return this;
	}

	/** Set the human-readable display name. */
	name(value: string): this {
		this._name = value;
		return this;
	}

	/** Set the semver version string (e.g. `"1.0.0"`). */
	version(value: string): this {
		this._version = value;
		return this;
	}

	/** Append a pre-built `RunnableMeta` (from any per-kind builder). */
	runnable(meta: RunnableMeta): this {
		this._runnables.push(meta);
		return this;
	}

	/** Declare a permission grant (e.g. `"mcp:web_search"`). */
	grant(permission: string): this {
		this._grants.push(permission);
		return this;
	}

	/** Set an optional Companion surface descriptor. */
	companion(surface: CompanionSurface): this {
		this._companion = surface;
		return this;
	}

	/**
	 * Declare a **plugin-to-plugin dependency**: `id` must be installed and is
	 * auto-enabled (in dependency order) before this plugin enables.
	 *
	 * `minVersion` is a MINIMUM — a bare `"1.2.0"` means `">=1.2.0"`, so an
	 * installed `2.0.0` satisfies it (comparator syntax like `">=1.2, <2"` is
	 * honoured verbatim).
	 */
	dependsOn(id: string, minVersion?: string): this {
		this._dependencies.push(
			minVersion ? { id, min_version: minVersion } : { id }
		);
		return this;
	}

	/**
	 * Declare a permission grant implied by this plugin's dependencies
	 * (`requires.grants`). Declaration only — the Gateway remains the sole
	 * authority on what a grant allows. Use {@link PluginBuilder.grant} for the
	 * grants this plugin needs in its own right.
	 */
	requiredGrant(permission: string): this {
		this._requiredGrants.push(permission);
		return this;
	}

	/**
	 * Restrict this plugin to a host surface (`"desktop"`, `"island"`, …).
	 * Declaring NO target is the default and means **every** surface.
	 */
	target(surface: Surface): this {
		this._targets.push(surface);
		return this;
	}

	/**
	 * Validate and return the assembled `PluginManifest`. Throws an `Error` with
	 * the failing field name and message when validation fails.
	 */
	build(): PluginManifest {
		// `requires` is omitted entirely when nothing was declared, so a manifest
		// with no dependencies serialises with no `requires` key — matching Core's
		// `Option<Requires>` + `skip_serializing_if`.
		const hasRequires =
			this._dependencies.length > 0 || this._requiredGrants.length > 0;

		const raw = {
			id: this._id,
			name: this._name,
			version: this._version,
			runnables: this._runnables,
			permission_grants: this._grants,
			companion: this._companion,
			targets: this._targets,
			...(hasRequires
				? {
						requires: {
							apps: this._dependencies,
							grants: this._requiredGrants,
						},
					}
				: {}),
		};

		const result = PluginManifestSchema.safeParse(raw);
		if (!result.success) {
			const first = result.error.issues[0];
			const field = first?.path.join(".") ?? "unknown";
			const message = first?.message ?? "validation failed";
			throw new Error(
				`plugin.json validation failed at '${field}': ${message}`
			);
		}
		return result.data;
	}
}

// ── AppBuilder (Ryu Apps) ─────────────────────────────────────────────────────

/**
 * Fluent builder for a Ryu App — a `plugin.json` whose tools render interactive
 * widgets inline in chat. Delegates to {@link defineApp} on `.build()`, so it
 * derives the render-vs-companion split and validates through
 * `PluginManifestSchema` (throwing a descriptive `Error` on bad input) exactly
 * like the factory.
 *
 * @example
 * ```ts
 * import { app } from "@ryuhq/sdk/builder"
 *
 * const manifest = app()
 *   .id("com.example.checklist")
 *   .title("Checklist")
 *   .version("1.0.0")
 *   .slug("checklist")
 *   .uiEntry("src/checklist.tsx")
 *   .tool({ name: "render", description: "Render a checklist", invoking: "Building…" })
 *   .tool({ name: "toggle", description: "Toggle an item", accessible: true })
 *   .build()
 * ```
 */
export class AppBuilder {
	private _id = "";
	private _title = "";
	private _version = "";
	private _slug = "";
	private _server: string | undefined = undefined;
	private _displayMode: string | undefined = undefined;
	private _mime: string | undefined = undefined;
	private _uiEntry = "";
	private readonly _grants: string[] = [];
	private readonly _activationEvents: string[] = [];
	private readonly _tools: AppToolSpec[] = [];
	private readonly _dependencies: AppDependency[] = [];
	private readonly _requiredGrants: string[] = [];
	private readonly _targets: Surface[] = [];

	/** Set the reverse-domain app id (e.g. `"com.example.checklist"`). */
	id(value: string): this {
		this._id = value;
		return this;
	}

	/** Set the human-readable display name. */
	title(value: string): this {
		this._title = value;
		return this;
	}

	/** Set the semver version string (e.g. `"1.0.0"`). */
	version(value: string): this {
		this._version = value;
		return this;
	}

	/** Set the app slug (drives `ui://widget/<slug>.html` and the server default). */
	slug(value: string): this {
		this._slug = value;
		return this;
	}

	/** Override the MCP server namespace for tool ids (defaults to the slug). */
	server(value: string): this {
		this._server = value;
		return this;
	}

	/** Set the default widget display mode (`inline` | `fullscreen` | `pip`). */
	displayMode(value: string): this {
		this._displayMode = value;
		return this;
	}

	/** Override the widget MIME dialect (defaults to `text/html+skybridge`). */
	mime(value: string): this {
		this._mime = value;
		return this;
	}

	/** Set the widget UI source entry `ryu pack` bundles into `ui_code`. */
	uiEntry(value: string): this {
		this._uiEntry = value;
		return this;
	}

	/** Declare a permission grant (e.g. `"mcp:web_search"`). */
	grant(permission: string): this {
		this._grants.push(permission);
		return this;
	}

	/** Add a VS-Code-style activation event (empty = eager `["*"]`). */
	activationEvent(event: string): this {
		this._activationEvents.push(event);
		return this;
	}

	/** Append a tool spec (render tool unless `accessible:true`). */
	tool(spec: AppToolSpec): this {
		this._tools.push(spec);
		return this;
	}

	/**
	 * Declare a **plugin-to-plugin dependency** (auto-enabled, in dependency order,
	 * before this app). `minVersion` is a MINIMUM (`"1.2.0"` = `">=1.2.0"`).
	 */
	dependsOn(id: string, minVersion?: string): this {
		this._dependencies.push(
			minVersion ? { id, min_version: minVersion } : { id }
		);
		return this;
	}

	/** Declare a grant implied by this app's dependencies (`requires.grants`). */
	requiredGrant(permission: string): this {
		this._requiredGrants.push(permission);
		return this;
	}

	/** Restrict this app to a host surface. No target = every surface. */
	target(surface: Surface): this {
		this._targets.push(surface);
		return this;
	}

	/**
	 * Validate and return the assembled `PluginManifest`. Throws an `Error` naming
	 * the failing field when validation fails.
	 */
	build(): PluginManifest {
		const hasRequires =
			this._dependencies.length > 0 || this._requiredGrants.length > 0;

		const options: DefineAppOptions = {
			id: this._id,
			title: this._title,
			version: this._version,
			slug: this._slug,
			uiEntry: this._uiEntry,
			tools: this._tools,
			grants: this._grants,
			...(this._server ? { server: this._server } : {}),
			...(this._displayMode ? { displayMode: this._displayMode } : {}),
			...(this._mime ? { mime: this._mime } : {}),
			...(this._activationEvents.length > 0
				? { activationEvents: this._activationEvents }
				: {}),
			...(hasRequires
				? {
						requires: {
							apps: this._dependencies,
							grants: this._requiredGrants,
						},
					}
				: {}),
			...(this._targets.length > 0 ? { targets: this._targets } : {}),
		};
		return defineApp(options);
	}
}

/** Create an AppBuilder. */
export const app = () => new AppBuilder();
