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

import { createRequire } from "node:module";
import { z } from "zod";

// ── Lazy, optional native addon ──────────────────────────────────────────────
//
// The Rust-cored validation helpers at the bottom of this file delegate to the
// `@ryuhq/sdk-native` napi addon (`crates/ryu-sdk-napi`). That addon is a
// prebuilt, platform-specific `.node` binary and is *not* always present — e.g.
// in a fresh `create-ryu-app` scaffold context, which imports this module only
// for `PluginManifestSchema` (pure-JS zod). Importing `@ryuhq/sdk/manifest`
// must therefore never hard-require the addon at module load. We load it lazily
// on first use of a helper that needs it, cache it, and throw a descriptive
// error only if a caller actually invokes those helpers without the addon.
interface NativeAddon {
	parseAndValidateManifest(manifestJson: string): string;
	pluginManifestJsonSchema(): string;
	validatePluginId(id: string): void;
}

let cachedNative: NativeAddon | null = null;
let nativeLoadError: Error | null = null;

/**
 * Load the `@ryuhq/sdk-native` addon on demand. Uses a synchronous `require`
 * (via `createRequire`) so the surrounding helpers can stay synchronous, and
 * works in both the ESM and CJS builds (tsup `shims` provides `import.meta.url`
 * in the CJS output). Throws a descriptive error when the addon is absent.
 */
function loadNative(): NativeAddon {
	if (cachedNative) {
		return cachedNative;
	}
	if (nativeLoadError) {
		throw nativeLoadError;
	}
	try {
		const req = createRequire(import.meta.url);
		cachedNative = req("@ryuhq/sdk-native") as NativeAddon;
		return cachedNative;
	} catch (cause) {
		nativeLoadError = new Error(
			"@ryuhq/sdk-native (the Rust-cored napi addon) is not available; " +
				"Core-strict manifest validation requires it. Build/install the addon, " +
				"or use PluginManifestSchema (pure-JS zod) for authoring-time validation.",
			{ cause }
		);
		throw nativeLoadError;
	}
}

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
	/**
	 * Cheap pre-gate mirroring Core's `HookMatch` (serde name `match` on
	 * `TurnHookContribution.run_when`). MUST round-trip through this schema:
	 * `ryu pack`/`publish` persist `safeParse(...).data`, so a field missing here
	 * is silently STRIPPED before signing — a tool-gated `pre_tool_use` hook
	 * (e.g. `tools: ["bash*"]`) would lose its gate and run on EVERY tool call.
	 */
	match: z
		.object({
			/** Run only if the request set this composer flag true. */
			flag: z.string().optional(),
			/** Run if the last user message starts with any of these prefixes. */
			commands: z.array(z.string()).default([]),
			/** Run if the plugin has stored state for this conversation. */
			stateful: z.boolean().default(false),
			/** Run if `ctx.tool_name` matches any of these `*`-wildcard patterns. */
			tools: z.array(z.string()).default([]),
		})
		.optional(),
});

export type TurnHookContribution = z.infer<typeof TurnHookContributionSchema>;

// ── WidgetContribution (Ryu Apps) ─────────────────────────────────────────────

/** Default widget MIME dialect. Mirrors Core `default_widget_mime`. */
const DEFAULT_WIDGET_MIME = "text/html+skybridge";
/** Default widget display mode. Mirrors Core `default_widget_display_mode`. */
const DEFAULT_WIDGET_DISPLAY_MODE = "inline";

/**
 * One app-widget contribution (Ryu Apps). Binds the render tool that produces the
 * widget to its `ui://widget/<slug>.html` template. Shape-identical to Core's
 * `WidgetContribution` (`apps/core/src/plugin_manifest/mod.rs`): built-in apps
 * serve the HTML from the in-process provider and leave `ui_entry` unset, while a
 * third-party app authored here sets `ui_entry` so `ryu pack` bundles the source
 * into the manifest's `ui_code`.
 */
export const WidgetContributionSchema = z.object({
	/** The fully-qualified tool id whose result renders this widget. */
	tool_id: z.string().min(1),
	/** `ui://widget/<slug>.html` — the widget resource uri. */
	uri: z.string().min(1),
	/** Source entry (e.g. `src/apps/checklist/index.tsx`) for `ryu pack`. */
	ui_entry: z.string().optional(),
	/** Widget MIME dialect (default `text/html+skybridge`). */
	mime: z.string().default(DEFAULT_WIDGET_MIME),
	/** Default display mode (`inline` | `fullscreen` | `pip`). */
	default_display_mode: z.string().default(DEFAULT_WIDGET_DISPLAY_MODE),
});

export type WidgetContribution = z.infer<typeof WidgetContributionSchema>;

// ── ToolAppConfig (Ryu Apps per-tool config) ─────────────────────────────────

/**
 * The `config` blob carried by a Ryu App's `kind:"tool"` runnable. Core's strict
 * `ToolConfig` (`apps/core/src/plugin_manifest/schema.rs`) requires `slug` and
 * ignores unknown fields on the current shape; the widget flags below are read by
 * Core's `register_app_tool_with_widget` synthesis path (a separate Core unit) to
 * rebuild the `_meta` binding, mirroring how the in-process `apps::tools()`
 * derives `outputTemplate` / `toolInvocation` / `widgetAccessible`.
 */
export const ToolAppConfigSchema = z.object({
	/** MCP tool slug this runnable wraps — the fully-qualified `<server>__<name>` id. */
	slug: z.string().min(1),
	/** The tool description the model reads when choosing it. Carried here because a
	 *  packed app's manifest is the only channel (there is no `generated.rs`); Core's
	 *  app-tool synthesis reads it back onto the `RegistryTool`. */
	description: z.string(),
	/** JSON Schema for the tool's arguments (used for validation + the LLM tool
	 *  surface). Snake_case to match `widget_accessible`. Absent = no arguments. */
	input_schema: z.record(z.string(), z.unknown()).optional(),
	/** True when calling this tool renders the app's widget (carries the template). */
	widget: z.boolean().default(false),
	/** True when a mounted widget may `callTool` this tool (a companion), or when a
	 *  render tool's widget may call any companion the app declares. */
	widget_accessible: z.boolean().default(false),
	/** Optional status label shown while the render tool runs. */
	invoking: z.string().optional(),
	/** Optional status label shown when the render tool finishes. */
	invoked: z.string().optional(),
});

export type ToolAppConfig = z.infer<typeof ToolAppConfigSchema>;

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
	/** App widgets (Ryu Apps). Each binds a render tool id to its
	 *  `ui://widget/<slug>.html` template. Mirrors the Rust-side
	 *  `Contributes.widgets` field, without which the CLI's zod parse would strip
	 *  every widget an app authored here declares. */
	widgets: z.array(WidgetContributionSchema).default([]),
	/** App-registered sidebar sections (header + live list) and buttons (single nav
	 *  rows). Loosely typed here — the shell owns the spec vocabulary — matching how
	 *  `composer_controls`/`settings_tabs` are declared. Mirrors the Rust-side
	 *  `Contributes.sidebar_sections` / `Contributes.sidebar_buttons`. */
	sidebar_sections: z.array(z.record(z.string(), z.unknown())).default([]),
	sidebar_buttons: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type Contributes = z.infer<typeof ContributesSchema>;

// ── SetupStep (listing companion/config card) ────────────────────────────────

/**
 * One optional post-install setup/companion card step surfaced on the
 * marketplace detail dialog (Phase 1.5 Ryu extension). All fields optional so a
 * card can be a bare call-to-action or a labelled instruction. `ryu publish`
 * forwards this into the publish body's `setup` field.
 */
export const SetupStepSchema = z.object({
	/** Card heading (e.g. the companion app name). */
	title: z.string().optional(),
	/** Instruction body shown under the title. */
	description: z.string().optional(),
	/** Label for the optional action button. */
	actionLabel: z.string().optional(),
	/** URL the action button opens (validated server-side on publish). */
	actionUrl: z.string().optional(),
});

export type SetupStep = z.infer<typeof SetupStepSchema>;

// ── Requires (plugin-to-plugin dependencies) ─────────────────────────────────

/**
 * A single plugin-to-plugin dependency edge. Mirrors `AppDependency` in
 * `apps/core/src/plugin_manifest/mod.rs`.
 *
 * `min_version` is snake_case on the wire (Core declares no serde rename) and is
 * a **minimum**, not a caret range: a bare `"1.2.0"` means `">=1.2.0"`, so an
 * installed `2.0.0` satisfies it. Explicit comparator syntax (`">=1.2, <2"`,
 * `"^1.2"`, `"~1.2"`) is honoured verbatim by Core's `parse_min_version`.
 */
export const AppDependencySchema = z.object({
	/** The `id` of the plugin this one depends on. */
	id: z.string().min(1, "dependency id is required"),
	/** Optional MINIMUM version the dependency must satisfy (`"1.2.0"` = `">=1.2.0"`). */
	min_version: z.string().min(1).optional(),
});

export type AppDependency = z.infer<typeof AppDependencySchema>;

/**
 * A single **capability** edge — the layered, provider-agnostic dependency
 * (`requires: [{ capability: "rag" }]`) the capability broker resolves to a
 * concrete provider app at bind time. Mirrors `CapabilityReq` in
 * `crates/ryu-kernel-contracts/src/manifest.rs` (the canonical contract):
 * `{ capability, min_version? }`. Distinct from an `apps` edge (which names a
 * specific plugin id); a `capabilities` edge names an abstract capability and
 * lets the binding registry pick — or the user override — which enabled provider
 * serves it. This is the field the composable `defineAgent` slots lower to.
 */
export const CapabilityReqSchema = z.object({
	/** Capability name (e.g. `"rag"`, `"memory"`, `"tts"`). Matched against a
	 *  provider's `provides[].capability`. */
	capability: z.string().min(1, "capability name is required"),
	/** Optional MINIMUM capability version the bound provider must satisfy
	 *  (`"1.2.0"` = `">=1.2.0"`). Absent = any version. */
	min_version: z.string().min(1).optional(),
});

export type CapabilityReq = z.infer<typeof CapabilityReqSchema>;

/**
 * The `requires` block — this plugin's dependencies. Mirrors `Requires` in
 * `apps/core/src/plugin_manifest/mod.rs`.
 *
 * Core resolves `apps` into a topological enable order (`plugins::graph`):
 * enabling this plugin auto-enables its dependencies first, and disabling a
 * dependency is REFUSED (409) while an enabled dependent still needs it.
 *
 * **Absent = no dependencies** — the backward-compatible default every manifest
 * predating this field carries.
 */
export const RequiresSchema = z.object({
	/** Other plugins that must be installed + enabled before this one enables. */
	apps: z.array(AppDependencySchema).default([]),
	/**
	 * Abstract capability edges the broker resolves to a bound provider at
	 * enable time. Mirrors `Requires::capabilities` in
	 * `crates/ryu-kernel-contracts` — an `apps` edge names a specific plugin; a
	 * `capabilities` edge names a capability and lets the binding registry choose
	 * the provider. Each is lowered to an app-id graph edge once bound, so the
	 * enable/disable/cycle machinery is shared. Empty for the common case.
	 */
	capabilities: z.array(CapabilityReqSchema).default([]),
	/**
	 * Permission grants implied by the dependencies. Declaration only — the
	 * Gateway remains the sole authority on what a grant *allows*, and Core's
	 * dependency graph resolves `apps` only.
	 */
	grants: z.array(z.string()).default([]),
});

export type Requires = z.infer<typeof RequiresSchema>;

// ── Surface (targets) ────────────────────────────────────────────────────────

/**
 * A host surface a plugin can declare support for via `targets`. Mirrors Core's
 * `Surface` enum (`#[serde(rename_all = "kebab-case")]`), so these eight tokens
 * are the exact wire values — also the vocabulary of the `x-ryu-surface` request
 * header Core filters listings on.
 */
export const SurfaceSchema = z.enum([
	/** The Ryu Gateway. */
	"gateway",
	/** A headless Core node (no UI). */
	"core",
	/** The Tauri desktop app. */
	"desktop",
	/** The Electron dynamic-island companion. */
	"island",
	/** The Expo/React-Native mobile app. */
	"mobile",
	/** The browser extension. */
	"extension",
	/** The Next.js web app. */
	"web",
	/** The terminal client. */
	"cli",
]);

export type Surface = z.infer<typeof SurfaceSchema>;

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

	/**
	 * **Plugin-to-plugin dependencies** — the other plugins this one needs. Core
	 * resolves them into a topological enable order (dependencies enable first;
	 * disabling one is refused while an enabled dependent needs it).
	 *
	 * Absent = **no dependencies**, the backward-compatible default. Kept
	 * `.optional()` (never defaulted) so a manifest that declares none serialises
	 * with no `requires` key at all, exactly like Core's
	 * `#[serde(skip_serializing_if = "Option::is_none")]`.
	 */
	requires: RequiresSchema.optional(),

	/**
	 * Host surfaces this plugin runs on. **Empty or absent = runs on EVERY
	 * surface** — the backward-compatible default, which must never be read as
	 * "runs nowhere". Core filters only when the list is explicitly non-empty, and
	 * only at the read boundary (`GET /api/plugins`, keyed on `x-ryu-surface`), so
	 * an unsupported-target plugin stays installable and inspectable.
	 */
	targets: z.array(SurfaceSchema).default([]),

	/**
	 * Optional per-item AFFILIATE terms: the commission paid to a referrer when a
	 * referred user buys this (paid) item. `value` is basis points for `percent`
	 * (2000 = 20%) or minor units (cents) for `flat`. Absent (or `enabled:false`)
	 * falls back to the seller org owner's default affiliate terms. This is the
	 * authoring surface for the marketplace publish body's `affiliate` field (the
	 * server re-validates it); it only takes effect on a paid item.
	 */
	affiliate: z
		.object({
			enabled: z.boolean().default(false),
			rule: z
				.object({
					type: z.enum(["percent", "flat"]),
					value: z.number().nonnegative(),
					recurring: z.boolean().default(false),
					durationMonths: z.number().int().positive().nullish(),
					fundedBy: z.enum(["platform", "seller"]).default("platform"),
				})
				.optional(),
		})
		.optional(),

	// ── Rich listing metadata (Phase 1.5) ──────────────────────────────────────
	// Optional store-listing fields a plugin author declares so the marketplace
	// detail dialog renders a richer App-Store-style preview. Field names align
	// with the Claude `.claude-plugin/marketplace.json` plugin-entry standard where
	// one exists (`author`, `homepage`, `keywords`, `category`, `license`); the
	// rest are Ryu extensions. `ryu publish` forwards these FLAT into the publish
	// body (not inside the signed manifest blob) so the control plane stores them.
	// All optional + additive: a manifest omitting them still validates.

	/** Longer plain/markdown description shown in the detail dialog. */
	description: z.string().optional(),
	/** Short one-line pitch shown under the name (Ryu extension). */
	tagline: z.string().optional(),
	/**
	 * Publisher identity. A bare string OR a Claude-style object; `ryu publish`
	 * resolves it to the display `developer` (`author.name` when an object).
	 */
	author: z
		.union([
			z.string(),
			z.object({
				name: z.string(),
				email: z.string().optional(),
				url: z.string().optional(),
			}),
		])
		.optional(),
	/** Project/marketing homepage — maps to the listing `website` (Claude field). */
	homepage: z.string().optional(),
	/** Free-text search keywords (Claude field). */
	keywords: z.array(z.string()).optional(),
	/** Taxonomy category beyond the runnable kinds (Claude field). */
	category: z.string().optional(),
	/** SPDX-ish license identifier (Claude field). */
	license: z.string().optional(),
	/** Square logo/icon URL for the listing card + detail header. */
	iconUrl: z.string().optional(),
	/**
	 * Icon-primitive id for the listing card (Ryu extension): an Iconify/icons0
	 * `prefix:name`, a bare Hugeicons name, or a URL, resolved by the shared `Icon`
	 * primitive. A monochrome GLYPH masked with the current text colour — distinct
	 * from `iconUrl` (a raster logo). Falls back to `iconUrl` when omitted.
	 */
	icon: z.string().optional(),
	/**
	 * Dithered-gradient background for the card's icon square (Ryu extension),
	 * mirroring dither-kit's `DitherGradient` props. `from`/`to` are a palette-colour
	 * name (`green`, `blue`, `purple`, `pink`, `orange`, `red`, `grey`) or a hue
	 * number (0–360); `direction` is where `to` ends up. Renders behind the glyph in
	 * place of a flat `iconBackground`; the render layer validates + falls back.
	 */
	iconDither: z
		.object({
			from: z.union([z.string(), z.number()]),
			to: z.union([z.string(), z.number()]).optional(),
			direction: z.enum(["up", "down", "left", "right"]).optional(),
		})
		.optional(),
	/** Ordered App-Store-style screenshot gallery URLs (Ryu extension). */
	screenshots: z.array(z.string()).optional(),
	/** Privacy policy URL surfaced on detail (Ryu extension). */
	privacyPolicyUrl: z.string().optional(),
	/** Terms-of-service URL surfaced on detail (Ryu extension). */
	termsOfServiceUrl: z.string().optional(),
	/**
	 * Human-readable capability strings (Ryu extension). When omitted the control
	 * plane derives a default from `permission_grants`, so declaring this is only
	 * needed to override the derived labels.
	 */
	capabilities: z.array(z.string()).optional(),
	/** Example prompt chips shown on detail (Ryu extension). */
	examplePrompts: z.array(z.string()).optional(),
	/**
	 * Optional companion/config card (Ryu extension): a single setup step or an
	 * array of steps guiding the user through post-install configuration.
	 */
	setup: z.union([SetupStepSchema, z.array(SetupStepSchema)]).optional(),
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
	loadNative().validatePluginId(id);
}

/**
 * Validate a full `plugin.json` string against Core's authoritative rules
 * (id, semver, per-kind runnable config contracts). Returns the normalized
 * manifest JSON string, or throws.
 */
export function validateManifestStrict(manifestJson: string): string {
	return loadNative().parseAndValidateManifest(manifestJson);
}

/**
 * The Core-derived JSON Schema for a `plugin.json`, as a parsed object. Stays in
 * lockstep with the Rust types because it is emitted from them.
 */
export function coreManifestJsonSchema(): unknown {
	return JSON.parse(loadNative().pluginManifestJsonSchema());
}
