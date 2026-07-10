/**
 * Turn-hook + plugin authoring factories.
 *
 * A turn hook is plugin-authored logic that runs after each assistant turn in
 * Ryu's Core plugin sandbox (`apps/core/src/plugin_host/`). The hook reaches Core
 * only through capability-gated `host` functions and returns a directive. This is
 * what makes features like double-check and goal real, installable plugins.
 *
 * `defineTurnHook` serializes your typed `run(ctx, host)` function to the `code`
 * string the sandbox executes. IMPORTANT: the function must be **self-contained**
 * — it runs in a fresh sandbox with only `ctx` and `host` in scope, so it cannot
 * capture outer variables, imports, or closures (same constraint as a Web Worker
 * body). Reference only `ctx`, `host`, and language built-ins.
 */

import type {
	Contributes,
	PluginManifest,
	TurnHookContribution,
} from "../manifest.ts";

/** The context a `post_assistant_turn` hook receives. */
export interface HookContext {
	/** The agent that produced the turn. */
	agent_id?: string;
	/** The conversation id (also the natural per-conversation storage key). */
	conversation_id?: string;
	/** Per-request plugin flags (e.g. a composer toggle): `{ "<pluginId>": true }`. */
	flags: Record<string, boolean>;
	/** Recent transcript (oldest → newest). */
	transcript: Array<{ role: string; content: string }>;
}

/** Arguments to a `host.sideModel` call. */
export interface SideModelArgs {
	/** Reasoning effort, forwarded when non-empty. */
	effort?: string;
	/** Explicit model id (wins over `model_pref_key`). */
	model?: string;
	/** A preference key Core resolves to a model id (swappable, not hardcoded). */
	model_pref_key?: string;
	/** The user prompt for the side model. Required. */
	prompt: string;
	/** Optional system prompt. */
	system?: string;
}

/** The capability bridge available to a hook (gated by manifest grants). */
export interface HostApi {
	/** Captured logging. */
	log(...args: unknown[]): void;
	/** One non-streaming gateway completion. Grant: `hook:side-model`. */
	sideModel(args: SideModelArgs): Promise<string>;
	/** The plugin's own namespaced KV store. Grant: `storage:kv`. */
	storage: {
		get(key: string): Promise<string | null>;
		set(key: string, value: unknown): Promise<boolean>;
		delete(key: string): Promise<boolean>;
		keys(): Promise<string[]>;
	};
}

/** What a hook asks the chat path to do after the assistant turn. */
export type HookDirective =
	| { kind: "none" }
	| { kind: "note"; text: string }
	| { kind: "continue"; text: string };

/** A typed hook implementation: `(ctx, host) => directive`. */
export type HookRun = (
	ctx: HookContext,
	host: HostApi
) => HookDirective | Promise<HookDirective>;

export interface DefineTurnHookOptions {
	/** Stable id for this hook, unique within the plugin. */
	id: string;
	/** Turn boundary (default `"post_assistant_turn"`). */
	on?: string;
	/** The hook body. Must be self-contained (no captured variables). */
	run: HookRun;
}

/**
 * Build a turn-hook contribution from a typed `run` function. The function source
 * is serialized into the sandbox `code` string and invoked with `ctx`/`host` at
 * run time.
 */
export function defineTurnHook(
	options: DefineTurnHookOptions
): TurnHookContribution {
	const source = options.run.toString();
	// The sandbox wraps `code` in an async IIFE where `ctx`/`host` are in scope
	// and a bare `return` reports the directive — so call the serialized function
	// with them and return its result.
	const code = `return await (${source})(ctx, host);`;
	return {
		id: options.id,
		on: options.on ?? "post_assistant_turn",
		code,
	};
}

export interface DefinePluginOptions {
	/** Activation events (default `["*"]` — driven by the enabled flag). */
	activationEvents?: string[];
	/** Declarative composer widgets (toggle/chip), passed verbatim to the desktop. */
	composerControls?: Record<string, unknown>[];
	/** Capability grants the hooks need (e.g. `["hook:side-model", "storage:kv"]`). */
	grants?: string[];
	/** Reverse-domain id (e.g. `"com.example.my-plugin"`). */
	id: string;
	/** Display name. */
	name: string;
	/** Declarative settings tabs (model pickers, fields), passed verbatim. */
	settingsTabs?: Record<string, unknown>[];
	/** Declarative slash commands, passed verbatim. */
	slashCommands?: Record<string, unknown>[];
	/** Turn hooks the plugin contributes. */
	turnHooks?: TurnHookContribution[];
	/** Semver version (e.g. `"1.0.0"`). */
	version: string;
}

/**
 * Assemble a `plugin.json` manifest for a turn-hook plugin. The result matches
 * Core's `PluginManifest` serde shape and can be written to disk or validated via
 * `validateManifestStrict`.
 */
export function definePlugin(options: DefinePluginOptions): PluginManifest {
	const contributes: Contributes = {
		turn_hooks: options.turnHooks ?? [],
		composer_controls: options.composerControls ?? [],
		settings_tabs: options.settingsTabs ?? [],
		slash_commands: options.slashCommands ?? [],
		// A turn-hook plugin contributes no app widgets; the field is required on the
		// resolved `Contributes` type (zod default applied), so set it explicitly.
		widgets: [],
	};
	return {
		id: options.id,
		name: options.name,
		version: options.version,
		runnables: [],
		permission_grants: options.grants ?? [],
		activation_events: options.activationEvents ?? ["*"],
		contributes,
	};
}
