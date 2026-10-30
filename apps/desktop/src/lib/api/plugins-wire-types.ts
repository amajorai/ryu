import type {
	CardDither,
	CatalogDeprecation,
	CatalogLayer,
	CatalogSurfaceSupport,
} from "@ryu/marketplace/catalog/types";
import type { Surface } from "@ryuhq/core-client/plugins.ts";
import type { PluginValue } from "./plugin-wire-values.ts";

// ── Wire types (Rust/serde shape) ────────────────────────────────────────────

export interface RunnableEntryWire {
	config?: PluginValue;
	id: string;
	kind: string;
	name: string;
	/** Publisher identity mark from the control plane. */
	publisher_trust?: "gold" | "blue" | "dotted" | null;
	publisher_trust_source?:
		| "ryu_staff"
		| "paid_plan"
		| "stripe_connect"
		| "none"
		| null;
}

/** Manifest parsing preserves Core's explicit unknown-surface sentinel. */
export type ManifestTarget = Surface | "unknown";

/** One plugin-to-plugin dependency edge. Mirrors Core's `AppDependency`
 *  (`apps/core/src/plugin_manifest/mod.rs`). `min_version` is snake_case on the
 *  wire (Core declares no serde rename) and is a MINIMUM: `"1.2.0"` = `">=1.2.0"`. */
export interface AppDependencyWire {
	id: string;
	min_version?: string | null;
}

/** The `requires` block. Mirrors Core's `Requires`. Absent = no dependencies. */
export interface RequiresWire {
	apps?: AppDependencyWire[];
	grants?: string[];
}

export interface AppManifestWire {
	/** Primary brand accent from the manifest (`accentColor`). */
	accentColor?: string | null;
	/** Grants approved on the last successful enable, injected by `list_apps` from
	 *  the lifecycle RECORD (absent on a node predating that, hence optional). */
	approved_grants?: string[];
	// System app fields injected by list_apps for Ghost/Shadow
	built_in: boolean;
	/** Free-text store category (`category`), e.g. "Productivity". */
	category?: string | null;
	// Injected by list_apps handler
	/** The release train this install follows; null when not installed. */
	channel?: string | null;
	companion?: {
		label: string;
		icon?: string | null;
		shortcut?: string | null;
	} | null;
	/** Normalised deprecation notice (Core rewrites the manifest's three shapes
	 *  into this one). Absent = current. */
	deprecated?: CatalogDeprecation | null;
	/** Long plaintext/markdown description. */
	description?: string | null;
	developer?: string | null;
	enabled: boolean;
	external?: boolean;
	/** Icon-primitive id / `svgl:<slug>` (contract key `icon`). */
	icon?: string | null;
	/** CSS background for the icon square (contract key `iconBackground`). */
	iconBackground?: string | null;
	/** Dithered-gradient background for the icon square (`iconDither`). */
	iconDither?: CardDither | null;
	/** Inset and letterbox treatment for the icon art (`iconPadding`). */
	iconPadding?: string | null;
	/** Raster logo (contract key `iconUrl`). */
	iconUrl?: string | null;
	id: string;
	installed: boolean;
	installed_version: string | null;
	layers?: CatalogLayer[];
	local_only: boolean;
	/** Required for Core — Disable/Uninstall are refused (403, no force). */
	mandatory?: boolean;
	mcp_servers?: Record<
		string,
		{
			auth?: { type?: string; client_id?: string | null } | null;
			url?: string | null;
		}
	>;
	name: string;
	optional_permission_grants?: string[];
	permission_grants: string[];
	/** Plugin-to-plugin dependencies. Absent (`skip_serializing_if`) = none. */
	requires?: RequiresWire | null;
	runnables: RunnableEntryWire[];
	sidecar_name: string | null;
	/** How finished this listing is ("alpha", "beta", …). Absent/"stable" = no badge. */
	stability?: string | null;
	/** True when the user has this ENABLED but Safe Mode is holding it back this
	 *  boot. `enabled` stays the user's own choice — Safe Mode is a read mask, not
	 *  a write — so without this the card would show "enabled" beside a panel that
	 *  is gone. Absent on a node predating Safe Mode. */
	suppressed_by_safe_mode?: boolean;
	/** Display-only per-surface support levels from Core. */
	surface_support?: CatalogSurfaceSupport[];
	/** Core refuses to uninstall it (`is_uninstall_protected`): the "System" label. */
	system?: boolean;
	/** Short one-line pitch shown under the name. */
	tagline?: string | null;
	/** Host surfaces the plugin runs on. Absent/empty = EVERY surface. */
	targets?: ManifestTarget[];
	/** Core-derived provenance tier. Never infer this from the manifest id. */
	tier?: PluginValue;
	version: string;
	windows_first: boolean;
}

export interface AppRecordWire {
	approved_grants: string[];
	created_at: string | null;
	enabled: boolean;
	id: string;
	updated_at: string | null;
	version: string;
}
