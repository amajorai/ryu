// packages/core-client/src/plugins-mappers.ts
//
// Wire -> client mappers for plugin manifests and lifecycle records.
// Re-exported through `./plugins.ts`.

import type { AppCommand, AppInfo, AppRecord } from "./plugins-types.ts";
import {
	type AppManifestWire,
	type AppRecordWire,
	pluginString,
} from "./plugins-wire.ts";

// ── Mappers ───────────────────────────────────────────────────────────────────

/** Whether a contributed CLI command `path` is a safe `ext_proxy` sub-path.
 *
 *  A command path is concatenated onto `/api/ext/<appId>` and fetched, and a WHATWG
 *  URL parser resolves `..` segments — including their percent-encoded (`%2e`) and
 *  backslash-separated forms (`\` is a path separator for http URLs) — BEFORE the
 *  request is sent. A traversal path therefore escapes the plugin's proxy scope and
 *  hits an arbitrary internal Core/Gateway route with the full node bearer. Core's
 *  manifest loader rejects such paths at load ({@link validateCliCommandPath} in
 *  `crates/ryu-kernel-contracts`); this mirrors that check client-side so a rogue
 *  manifest that slipped past (or a compromised transport) is still never routed.
 *
 *  Accepts only an absolute, single-origin sub-path: leading `/`, no backslash, no
 *  literal or percent-encoded `..`, and no percent-encoded path separators. */
export function isSafeCommandPath(path: string): boolean {
	if (!path.startsWith("/")) {
		return false;
	}
	if (path.includes("\\")) {
		return false;
	}
	const lower = path.toLowerCase();
	if (path.includes("..") || lower.includes("%2e")) {
		return false;
	}
	if (lower.includes("%2f") || lower.includes("%5c")) {
		return false;
	}
	return true;
}

/** Parse the manifest's `surfaces.cli.commands` into the client-side
 *  {@link AppCommand}[]. Defensive: an entry missing `name`/`path` is skipped
 *  (never a partial command the dispatcher can't route); an entry whose `path`
 *  fails {@link isSafeCommandPath} (a path-traversal / SSRF attempt) is dropped so
 *  it can never be dispatched; `method` is uppercased with a `POST` default;
 *  `summary` normalizes to `null`. */
function toAppCommands(surfaces: AppManifestWire["surfaces"]): AppCommand[] {
	const raw = surfaces?.cli?.commands ?? [];
	const commands: AppCommand[] = [];
	for (const c of raw) {
		if (
			!(
				pluginString.safeParse(c?.name).success &&
				pluginString.safeParse(c?.path).success
			)
		) {
			continue;
		}
		if (!isSafeCommandPath(c.path)) {
			continue;
		}
		commands.push({
			name: c.name,
			path: c.path,
			method: (c.method ?? "POST").toUpperCase(),
			summary: c.summary ?? null,
		});
	}
	return commands;
}

export function toAppInfo(w: AppManifestWire): AppInfo {
	return {
		builtIn: w.built_in ?? false,
		commands: toAppCommands(w.surfaces),
		companion: w.companion
			? {
					label: w.companion.label,
					icon: w.companion.icon ?? null,
					shortcut: w.companion.shortcut ?? null,
				}
			: null,
		enabled: w.enabled,
		id: w.id,
		installed: w.installed,
		installedVersion: w.installed_version,
		localOnly: w.local_only ?? false,
		name: w.name,
		permissionGrants: w.permission_grants,
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
		// Absent/empty targets = every surface. Never invent a default surface here:
		// treating "" as "none" would hide every plugin that predates the field.
		targets: w.targets ?? [],
		surfaceSupport: w.surface_support ?? [],
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
