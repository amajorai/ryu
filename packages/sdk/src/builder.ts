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
	CompanionSurface,
	PluginManifest,
	RunnableMeta,
} from "./manifest.ts";
import { PluginManifestSchema, RunnableMetaSchema } from "./manifest.ts";

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
	 * Validate and return the assembled `PluginManifest`. Throws an `Error` with
	 * the failing field name and message when validation fails.
	 */
	build(): PluginManifest {
		const raw = {
			id: this._id,
			name: this._name,
			version: this._version,
			runnables: this._runnables,
			permission_grants: this._grants,
			companion: this._companion,
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
