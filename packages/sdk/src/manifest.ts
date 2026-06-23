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

import * as nativeAddon from "@ryu/sdk-native";
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
});

export type RunnableMeta = z.infer<typeof RunnableMetaSchema>;

// ── CompanionSurface ─────────────────────────────────────────────────────────

/**
 * Optional in-desktop overlay / sidebar panel descriptor. Mirrors
 * `CompanionSurface` in `apps/core/src/plugin_manifest/mod.rs`.
 */
export const CompanionSurfaceSchema = z.object({
	/** Display label for the companion panel tab or tooltip. */
	label: z.string().min(1),
	/** Icon identifier resolved by the desktop shell. */
	icon: z.string().optional(),
	/** Keyboard shortcut string (e.g. `"ctrl+shift+r"`). */
	shortcut: z.string().optional(),
});

export type CompanionSurface = z.infer<typeof CompanionSurfaceSchema>;

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
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ── Rust-cored validation helpers (via @ryu/sdk-native) ───────────────────────
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
