// packages/core-client/src/plugins-wire.ts
//
// Zod response schemas and snake_case wire interfaces (Rust/serde shape) for
// Core's Plugin lifecycle endpoints. Re-exported through `./plugins.ts`.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import type { Surface, SurfaceSupportSummary } from "./plugins-types.ts";

export const pluginString = z.string();
export const pluginJsonFields = z.record(z.string(), appResponseValueSchema);
// Decode only HTTP JSON; retain the complete native tree and original keys.
export const pluginJsonObject = z.custom<z.output<typeof pluginJsonFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		pluginJsonFields.safeParse(value).success
);

const pluginPreviewFields = z.object({
	action: z.enum(["install", "enable", "disable", "uninstall", "update"]),
	dryRun: z.literal(true),
	success: z.boolean(),
});
export const pluginPreviewResponse = z.custom<
	z.output<typeof pluginPreviewFields> & z.output<typeof pluginJsonFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginPreviewFields.safeParse(value).success
);
const pluginHookFields = z.object({
	id: pluginString,
	title: pluginString,
	description: pluginString.nullable().optional(),
	plugin: pluginString.optional(),
	payload_example: appResponseValueSchema.optional(),
});
const pluginHookArrayFields = z.array(pluginHookFields);
const pluginHooksResponse = z.custom<z.output<typeof pluginHookArrayFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		pluginHookArrayFields.safeParse(value).success
);
const pluginHookEnvelopeFields = z.object({
	hook_events: pluginHooksResponse.optional(),
});
export const pluginHookEnvelope = z.custom<
	z.output<typeof pluginHookEnvelopeFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginHookEnvelopeFields.safeParse(value).success
);

const pluginProvenanceFields = z.object({
	source_id: pluginString.optional(),
	publisher_org: pluginString.optional(),
	org_verified: z.boolean(),
	org_verified_tier: pluginString.optional(),
	signature_verified: z.boolean(),
	manifest_sha256: pluginString.optional(),
	builtin: z.boolean(),
	captured_at: pluginString.optional(),
});
const pluginRecordFields = z.object({
	id: pluginString,
	version: pluginString,
	enabled: z.boolean(),
	approved_grants: z.array(pluginString),
	channel: pluginString.optional(),
	provenance: pluginProvenanceFields.nullable().optional(),
	created_at: pluginString.nullable(),
	updated_at: pluginString.nullable(),
});
const pluginRecord = z.custom<z.output<typeof pluginRecordFields>>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginRecordFields.safeParse(value).success
);
const pluginRecordEnvelopeFields = z.object({ app: pluginRecord });
export const pluginRecordEnvelope = z.custom<
	z.output<typeof pluginRecordEnvelopeFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginRecordEnvelopeFields.safeParse(value).success
);

const pluginSidecarFields = z.object({
	name: pluginString,
	running: z.boolean(),
	lazy: z.boolean().optional(),
	pid: z.number().optional(),
	memory_bytes: z.number().optional(),
	cpu_percent: z.number().optional(),
	failure_reason: pluginString.optional(),
});
const pluginSidecarArrayFields = z.array(pluginSidecarFields);
const pluginSidecarArray = z.custom<z.output<typeof pluginSidecarArrayFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		pluginSidecarArrayFields.safeParse(value).success
);
const pluginSidecarEnvelopeFields = z.object({
	sidecars: pluginSidecarArray.optional(),
	native_permissions: appResponseValueSchema.optional(),
	node_runtime: pluginString.nullable().optional(),
	missing_binaries: appResponseValueSchema.optional(),
});
export const pluginSidecarEnvelope = z.custom<
	z.output<typeof pluginSidecarEnvelopeFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginSidecarEnvelopeFields.safeParse(value).success
);
const pluginUninstallFields = z.object({
	disabled: z.array(pluginString).nullable().optional(),
	externally_managed: z.boolean().optional(),
	notice: pluginString.optional(),
	removed: pluginString.nullable().optional(),
	success: z.boolean().nullable().optional(),
	cleanup: appResponseValueSchema.optional(),
	cleanup_errors: appResponseValueSchema.optional(),
});
export const pluginUninstallResponse = z.custom<
	z.output<typeof pluginUninstallFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginUninstallFields.safeParse(value).success
);
const pluginCommandsFields = z.array(
	z.object({
		name: pluginString,
		path: pluginString,
		method: pluginString.nullable().optional(),
		summary: pluginString.nullable().optional(),
	})
);
const pluginSurfaceEntryFields = z.object({
	commands: pluginCommandsFields.optional(),
	support: pluginString.optional(),
	ui: appResponseValueSchema.optional(),
});
const pluginSurfacesFields = z.record(z.string(), pluginSurfaceEntryFields);
const pluginSurfaces = z.custom<z.output<typeof pluginSurfacesFields>>(
	(value) =>
		pluginSurfacesFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => pluginSurfaceEntryFields.safeParse(entry).success
		)
);
const pluginManifestFields = z.object({
	built_in: z.boolean(),
	companion: z
		.object({
			label: pluginString,
			icon: pluginString.nullable().optional(),
			shortcut: pluginString.nullable().optional(),
		})
		.nullable()
		.optional(),
	enabled: z.boolean(),
	id: pluginString,
	installed: z.boolean(),
	installed_version: pluginString.nullable(),
	local_only: z.boolean(),
	name: pluginString,
	permission_grants: z.array(pluginString),
	requires: z
		.object({
			apps: z
				.array(
					z.object({
						id: pluginString,
						min_version: pluginString.nullable().optional(),
					})
				)
				.optional(),
			grants: z.array(pluginString).optional(),
		})
		.nullable()
		.optional(),
	runnables: z.array(
		z.object({
			id: pluginString,
			kind: pluginString,
			name: pluginString,
			config: appResponseValueSchema.optional(),
		})
	),
	sidecar_name: pluginString.nullable(),
	surface_support: z
		.array(
			z.object({
				surface: pluginString,
				support: pluginString.nullable().optional(),
				inheritedFrom: pluginString.nullable().optional(),
			})
		)
		.optional(),
	surfaces: pluginSurfaces.nullable().optional(),
	targets: z
		.array(
			z.enum([
				"gateway",
				"core",
				"desktop",
				"island",
				"mobile",
				"extension",
				"web",
				"cli",
			])
		)
		.optional(),
	version: pluginString,
	windows_first: z.boolean(),
});
const pluginManifestArrayFields = z.array(pluginManifestFields);
const pluginManifestArray = z.custom<
	z.output<typeof pluginManifestArrayFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		pluginManifestArrayFields.safeParse(value).success
);
const pluginManifestEnvelopeFields = z.object({
	apps: pluginManifestArray.optional(),
});
export const pluginManifestEnvelope = z.custom<
	z.output<typeof pluginManifestEnvelopeFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		pluginManifestEnvelopeFields.safeParse(value).success
);

// ── Wire types (Rust/serde shape) ────────────────────────────────────────────

interface RunnableEntryWire {
	config?: unknown;
	id: string;
	kind: string;
	name: string;
}

/** One plugin-to-plugin dependency edge. Mirrors Core's `AppDependency`
 *  (`apps/core/src/plugin_manifest/mod.rs`). `min_version` is snake_case on the
 *  wire (Core declares no serde rename) and is a MINIMUM: `"1.2.0"` = `">=1.2.0"`. */
interface AppDependencyWire {
	id: string;
	min_version?: string | null;
}

/** The `requires` block. Mirrors Core's `Requires`. Absent = no dependencies. */
interface RequiresWire {
	apps?: AppDependencyWire[];
	grants?: string[];
}

/** One `surfaces.cli.commands[]` entry. Mirrors Core's `CliCommandSpec`
 *  (`crates/ryu-kernel-contracts/src/manifest.rs`). `method`/`summary` are
 *  `Option` in Rust (`skip_serializing_if`) so they may be absent/null. */
interface CliCommandWire {
	method?: string | null;
	name: string;
	path: string;
	summary?: string | null;
}

/** One `surfaces` map entry. Mirrors Core's `SurfaceEntry`. Only `commands` is
 *  consumed client-side today (the TUI `ryu <app> <cmd>` dispatcher); `support`
 *  and `ui` are carried opaquely for forward-compat. */
interface SurfaceEntryWire {
	commands?: CliCommandWire[];
	support?: string;
	ui?: unknown;
}
export interface AppManifestWire {
	// System app fields injected by list_apps for Ghost/Shadow
	built_in: boolean;
	companion?: {
		label: string;
		icon?: string | null;
		shortcut?: string | null;
	} | null;
	enabled: boolean;
	id: string;
	// Injected by list_apps handler
	installed: boolean;
	installed_version: string | null;
	local_only: boolean;
	name: string;
	permission_grants: string[];
	/** Plugin-to-plugin dependencies. Absent (`skip_serializing_if`) = none. */
	requires?: RequiresWire | null;
	runnables: RunnableEntryWire[];
	sidecar_name: string | null;
	/** Display-only support levels projected from the manifest. */
	surface_support?: SurfaceSupportSummary[];
	/** Per-surface support + UI + contributed commands. Absent = legacy `targets`
	 *  semantics; the `cli` entry's `commands` feed the TUI dispatcher. */
	surfaces?: Record<string, SurfaceEntryWire> | null;
	/** Host surfaces the plugin runs on. Absent/empty = EVERY surface. */
	targets?: Surface[];
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
