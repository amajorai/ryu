/**
 * Ryu SDK manifest types — TypeScript mirror of the Core `plugin_manifest` and
 * `runnable` schemas (`apps/core/src/plugin_manifest/mod.rs` and
 * `apps/core/src/runnable/mod.rs`).
 *
 * These types must stay in sync with the Rust serde shapes so that a manifest
 * authored here deserialises cleanly by `PluginManifestLoader::load()` in Core.
 *
 * Design note on engine/model fields: every field that holds an engine name,
 * model id, or provider reference is typed as `string` — never a union of
 * known provider literals.  A new provider must never require an SDK change.
 */

// biome-ignore lint/performance/noNamespaceImport: the native UniFFI addon exposes a dynamic set of bindings resolved at runtime; a namespace import is the addon's supported entry shape.
import * as nativeAddon from "@ryuhq/sdk-native";
import { z } from "zod";

// ── RunnableKind ─────────────────────────────────────────────────────────────

/**
 * The kind of a Runnable. Mirrors `RunnableKind` in
 * `apps/core/src/runnable/mod.rs`.
 */
export const RunnableKindSchema = z.enum([
	"agent",
	"workflow",
	"tool",
	"skill",
	// A companion surface (in-desktop panel). Added so a packable plugin can
	// declare a companion runnable that flows through Core's existing Companion
	// handler → app_contrib → `GET /api/plugins/contributions` → the desktop
	// `/plugin/<id>` route. Its `config.ui_entry` (see `CompanionRunnableConfigSchema`)
	// is what `ryu pack` bundles into `ui_code`.
	"companion",
]);

export type RunnableKind = z.infer<typeof RunnableKindSchema>;

// ── RunnableMeta ─────────────────────────────────────────────────────────────

/**
 * Kind-agnostic identity snapshot of a Runnable. Mirrors `RunnableMeta` in
 * `apps/core/src/runnable/mod.rs`.
 */
export const RunnableMetaSchema = z.object({
	/** Stable unique identifier (e.g. `"agent-researcher"`). */
	id: z.string().min(1),
	/** Human-readable display name. */
	name: z.string().min(1),
	/** Which kind of runnable this entry describes. */
	kind: RunnableKindSchema,
	/**
	 * Optional per-kind config blob. Mirrors Core's `RunnableEntry.config`
	 * (`Option<serde_json::Value>`) so a manifest authored here round-trips
	 * through Core-strict validation. Left opaque (a record) at this authoring
	 * layer; the per-kind shape is enforced by Core's `validate_runnable`.
	 *
	 * For a `companion` runnable, `config.ui_entry` names the plugin's UI entry
	 * module (relative to the manifest dir). `ryu pack` bundles that entry into
	 * the emitted `ui_code`; Core's `CompanionConfig.ui_entry` is the lockstep
	 * field so a packed companion validates.
	 */
	config: z.record(z.string(), z.unknown()).optional(),
});

export type RunnableMeta = z.infer<typeof RunnableMetaSchema>;

// ── CompanionSurface ─────────────────────────────────────────────────────────

/**
 * True when a companion `label` impersonates first-party Ryu/system chrome.
 *
 * Mirrors Core's `label_impersonates_system_chrome`
 * (`apps/core/src/plugin_manifest/schema.rs`) and the desktop `validatePluginRoute`
 * title gate (`apps/desktop/src/contributions/host/rpc.ts`): a plugin's visible
 * label may not contain `"ryu"` or `"system"` (case-insensitive), so a third-party
 * companion can never pose as built-in UI. The desktop host's mandatory,
 * non-removable `"Plugin ·"` attribution prefix is the primary guarantee; this is
 * defense in depth enforced at the authoring seam so a hostile label is rejected
 * before `ryu pack`/publish rather than at load.
 */
export function labelImpersonatesSystemChrome(label: string): boolean {
	const lower = label.toLowerCase();
	return lower.includes("ryu") || lower.includes("system");
}

/**
 * Optional in-desktop overlay / sidebar panel descriptor. Mirrors
 * `CompanionSurface` in `apps/core/src/plugin_manifest/mod.rs`.
 */
export const CompanionSurfaceSchema = z.object({
	/** Display label for the companion panel tab or tooltip. Anti-impersonation:
	 *  may not pose as first-party Ryu/system chrome (see
	 *  {@link labelImpersonatesSystemChrome}). */
	label: z
		.string()
		.min(1)
		.refine((value) => !labelImpersonatesSystemChrome(value), {
			message:
				"companion label must not impersonate system chrome (must not contain 'ryu' or 'system')",
		}),
	/** Icon identifier resolved by the desktop shell. */
	icon: z.string().optional(),
	/** Keyboard shortcut string (e.g. `"ctrl+shift+r"`). */
	shortcut: z.string().optional(),
});

export type CompanionSurface = z.infer<typeof CompanionSurfaceSchema>;

// ── Contributes (turn hooks + declarative UI) ────────────────────────────────

/**
 * A server-side chat turn hook. Mirrors `TurnHookContribution` in
 * `apps/core/src/plugin_manifest/mod.rs`. `code` is a JS body run in the plugin
 * sandbox with `ctx` + `host` in scope; it returns a directive. Authors usually
 * build this via `defineTurnHook` rather than writing the string by hand.
 */
export const TurnHookContributionSchema = z.object({
	/** Stable id for this hook (unique within the plugin). */
	id: z.string().min(1),
	/** Turn boundary this fires on. Today only `"post_assistant_turn"`. */
	on: z.string().min(1).default("post_assistant_turn"),
	/** The JS hook body executed in the sandbox (returns a directive). */
	code: z.string().min(1),
});

export type TurnHookContribution = z.infer<typeof TurnHookContributionSchema>;

/**
 * The `contributes` block. Mirrors `Contributes` in
 * `apps/core/src/plugin_manifest/mod.rs`. The declarative UI surfaces
 * (`composer_controls` / `settings_tabs` / `slash_commands`) are passed verbatim
 * to the desktop renderer, so they are typed loosely here (records).
 */
export const ContributesSchema = z.object({
	turn_hooks: z.array(TurnHookContributionSchema).default([]),
	composer_controls: z.array(z.record(z.string(), z.unknown())).default([]),
	settings_tabs: z.array(z.record(z.string(), z.unknown())).default([]),
	slash_commands: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type Contributes = z.infer<typeof ContributesSchema>;

// ── PluginManifest ───────────────────────────────────────────────────────────

/**
 * Full schema for a `plugin.json` Plugin manifest. Mirrors `PluginManifest` in
 * `apps/core/src/plugin_manifest/mod.rs`.
 *
 * Validation rules (matching Core's `PluginManifestLoader`):
 * - `id` must be non-empty
 * - `version` must be a valid semver string (MAJOR.MINOR.PATCH)
 * - `runnables` may be empty for a "surface-only" plugin, but each entry must be
 *   a valid `RunnableMeta`
 */
export const PluginManifestSchema = z.object({
	/** Reverse-domain unique identifier (e.g. `"com.example.my-plugin"`). */
	id: z.string().min(1, "id is required"),

	/** Human-readable display name shown in the plugin store / launcher. */
	name: z.string().min(1, "name is required"),

	/**
	 * Semver version string (e.g. `"1.0.0"`). Core's loader rejects any manifest
	 * whose version is not valid semver; the regex here enforces the same rule at
	 * SDK-build time.
	 */
	version: z
		.string()
		.regex(
			/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/,
			"version must be a valid semver string (e.g. 1.0.0)"
		),

	/**
	 * Lower-case hex `sha256(utf8_bytes(ui_code))` binding the plugin's bundled
	 * sandboxed-UI code to this manifest. `ryu pack` / `ryu publish` compute it and
	 * write it here BEFORE the manifest is signed, so the hash rides INSIDE the
	 * Gateway-signed surface while the `ui_code` blob rides OUTSIDE it as payload;
	 * Core's install path recomputes the hash over the fetched code and rejects a
	 * mismatch fail-closed. Absent for a manifest-only plugin (no bundled UI).
	 * Mirrors Core's `PluginManifest.ui_code_sha256`.
	 */
	ui_code_sha256: z.string().nullish(),

	/** The Runnables this plugin bundles. */
	runnables: z.array(RunnableMetaSchema).default([]),

	/**
	 * Permission grants this plugin declares it needs (e.g. `"mcp:web_search"`).
	 * Declarations only — grant enforcement is the Gateway's responsibility.
	 */
	permission_grants: z.array(z.string()).default([]),

	/**
	 * Optional Companion surface (an in-desktop overlay or sidebar panel).
	 * Absent when the plugin has no Companion surface.
	 */
	companion: CompanionSurfaceSchema.optional(),

	/**
	 * VS-Code-style activation events (`"*"`, `"onStartup"`, `"onChat"`,
	 * `"onCommand:<id>"`). Empty = eager. Turn-hook plugins are driven by their
	 * enabled flag, so `["*"]` is the usual value.
	 */
	activation_events: z.array(z.string()).default([]),

	/**
	 * Contribution points: server-side turn hooks + declarative UI widgets.
	 * Absent for a plugin that contributes nothing here.
	 */
	contributes: ContributesSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ── Rust-cored validation helpers (via @ryuhq/sdk-native) ───────────────────────
//
// These delegate to the `crates/ryu-sdk` Rust core through the native addon, so
// they apply the *exact same* rules Core enforces on load. Note: Core's manifest
// model uses richer per-kind `RunnableEntry` configs, while the zod
// `PluginManifestSchema` above models the SDK's simpler authoring shape
// (runnables = identity metadata only). Until those shapes are reconciled
// (follow-up), use the zod schema for SDK authoring and these helpers when you
// need Core-strict validation of a full `plugin.json`.

/**
 * Validate a plugin id with Core's strict reverse-domain, path-traversal-safe
 * rules. Throws a descriptive `Error` when invalid.
 */
export function validatePluginId(id: string): void {
	nativeAddon.validatePluginId(id);
}

/**
 * Validate a full `plugin.json` string against Core's authoritative rules
 * (id, semver, per-kind runnable config contracts). Returns the normalized
 * manifest JSON string, or throws.
 */
export function validateManifestStrict(manifestJson: string): string {
	return nativeAddon.parseAndValidateManifest(manifestJson);
}

/**
 * The Core-derived JSON Schema for a `plugin.json`, as a parsed object. Stays in
 * lockstep with the Rust types because it is emitted from them.
 */
export function coreManifestJsonSchema(): unknown {
	return JSON.parse(nativeAddon.pluginManifestJsonSchema());
}
