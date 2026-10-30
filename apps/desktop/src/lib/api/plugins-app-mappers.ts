import type { AppRecord } from "@ryuhq/core-client/plugins.ts";
import { type AppInfo, appTierFromWire } from "./plugins-client-types.ts";
import type { AppManifestWire, AppRecordWire } from "./plugins-wire-types.ts";

// ── Mappers ───────────────────────────────────────────────────────────────────

export function toAppInfo(w: AppManifestWire): AppInfo {
	return {
		approvedGrants: w.approved_grants ?? [],
		builtIn: w.built_in ?? false,
		tier: appTierFromWire(w.tier),
		category: w.category ?? null,
		companion: w.companion
			? {
					label: w.companion.label,
					icon: w.companion.icon ?? null,
					shortcut: w.companion.shortcut ?? null,
				}
			: null,
		description: w.description ?? null,
		enabled: w.enabled,
		external: w.external ?? false,
		accentColor: w.accentColor ?? null,
		icon: w.icon ?? null,
		iconBackground: w.iconBackground ?? null,
		iconDither: w.iconDither ?? null,
		iconPadding: w.iconPadding ?? null,
		iconUrl: w.iconUrl ?? null,
		id: w.id,
		channel: w.channel ?? null,
		installed: w.installed,
		installedVersion: w.installed_version,
		localOnly: w.local_only ?? false,
		mandatory: w.mandatory ?? false,
		system: w.system ?? false,
		mcpOAuthServers: Object.entries(w.mcp_servers ?? {}).flatMap(
			([name, server]) =>
				server.auth?.type === "oauth" && server.url
					? [
							{
								clientId: server.auth.client_id ?? null,
								name,
								resource: server.url,
							},
						]
					: []
		),
		name: w.name,
		permissionGrants: w.permission_grants,
		optionalPermissionGrants: w.optional_permission_grants ?? [],
		requires: w.requires
			? {
					apps: (w.requires.apps ?? []).map((d) => ({
						id: d.id,
						minVersion: d.min_version ?? null,
					})),
					grants: w.requires.grants ?? [],
				}
			: null,
		runnables: w.runnables.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			config: r.config ?? null,
		})),
		sidecarName: w.sidecar_name ?? null,
		stability: w.stability ?? null,
		deprecated: w.deprecated ?? null,
		surfaceSupport: w.surface_support ?? [],
		suppressedBySafeMode: w.suppressed_by_safe_mode ?? false,
		tagline: w.tagline ?? null,
		layers: w.layers ?? [],
		// Absent/empty targets = every surface. Never invent a default surface here:
		// treating "" as "none" would hide every plugin that predates the field.
		targets: w.targets ?? [],
		version: w.version,
		windowsFirst: w.windows_first ?? false,
	};
}

export function toAppRecord(w: AppRecordWire): AppRecord {
	return {
		id: w.id,
		version: w.version,
		enabled: w.enabled,
		approvedGrants: w.approved_grants,
		createdAt: w.created_at,
		updatedAt: w.updated_at,
	};
}
