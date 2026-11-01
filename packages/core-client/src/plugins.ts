// packages/core-client/src/plugins.ts
//
// Typed client for Core's Plugin lifecycle endpoints (`/api/plugins`). A Plugin
// is a manifest.json bundle descriptor (manifest) with a persisted lifecycle
// record (installed/enabled state). Consumed by the Extensions page via the
// `useApps` hook.
//
// Wire shapes use snake_case as serialised by Rust/serde; camelCase types are
// the client-side view exposed to React components. The internal symbol names
// (App*, fetchApps, etc.) are kept stable to limit churn across importers.
//
// `apps/desktop/src/lib/api/plugins.ts` re-exports the shared wire types from
// this module, so keep exported types compatible with the desktop's consumers.
//
// The implementation is split by responsibility into sibling `plugins-*.ts`
// modules; this file keeps the lifecycle API and re-exports every public symbol
// so `@ryuhq/core-client/plugins` stays the single import path.

import type { AppResponseValue } from "./app-request-json.ts";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";
import { parseLifecycleError } from "./plugins-errors.ts";
import { toAppInfo, toAppRecord } from "./plugins-mappers.ts";
import type { AppInfo, AppRecord } from "./plugins-types.ts";
import {
	pluginHookEnvelope,
	pluginManifestEnvelope,
	pluginPreviewResponse,
	pluginRecordEnvelope,
	pluginUninstallResponse,
} from "./plugins-wire.ts";

export type { CatalogEntry } from "./plugins-catalog.ts";
export {
	fetchAppsCatalog,
	installAppFromUrl,
	installPluginFromCatalog,
} from "./plugins-catalog.ts";
export type { AppDisabledError } from "./plugins-disabled.ts";
export { parseAppDisabled } from "./plugins-disabled.ts";
export type {
	AppLifecycleError,
	DependencyError,
	FutureDependencyFailure,
} from "./plugins-errors.ts";
export {
	dependencyErrorSchema,
	describeDependencyError,
	isBareVersionFloor,
} from "./plugins-errors.ts";
export { isSafeCommandPath } from "./plugins-mappers.ts";
export type {
	SidecarLifecyclePreview,
	SidecarPreviewUnavailable,
} from "./plugins-sidecar.ts";
export {
	fetchSidecarStatus,
	installSidecar,
	previewSidecarInstall,
	previewSidecarUninstall,
	startSidecar,
	stopSidecar,
} from "./plugins-sidecar.ts";
export type {
	AppCommand,
	AppDependency,
	AppInfo,
	AppRecord,
	AppRequires,
	RunnableEntry,
	Surface,
	SurfaceSupportSummary,
} from "./plugins-types.ts";

// ── Public API ────────────────────────────────────────────────────────────────

export type AppLifecycleAction =
	| "install"
	| "enable"
	| "disable"
	| "uninstall"
	| "update";

/** Build one lifecycle endpoint from a RAW plugin id. Scoped ids contain `/`, so
 *  the route parameter must be encoded once before it is joined to the path. */
function appLifecyclePath(id: string, action: AppLifecycleAction): string {
	return `/api/plugins/${encodeURIComponent(id)}/${action}`;
}

export interface AppLifecyclePreview {
	action: AppLifecycleAction;
	dryRun: true;
	success: boolean;
	[key: string]: AppResponseValue;
}

export interface AppLifecyclePreviewOptions {
	cascade?: boolean;
	channel?: string;
	force?: boolean;
	version?: string;
}

/** Run the lifecycle's server-side validation and dependency planner without
 * changing plugin state. The response is intentionally kept as a plan payload
 * rather than being coerced into an {@link AppRecord}; dry runs are not installs,
 * enables, disables, uninstalls, or updates. */
export async function previewAppLifecycle(
	target: ApiTarget,
	id: string,
	action: AppLifecycleAction,
	options: AppLifecyclePreviewOptions = {}
): Promise<AppLifecyclePreview> {
	const endpoint = appLifecyclePath(id, action);
	const query = new URLSearchParams();
	const isQueryAction = action === "disable" || action === "uninstall";
	if (isQueryAction) {
		query.set("dryRun", "true");
		if (options.cascade) {
			query.set("cascade", "true");
		}
		if (options.force) {
			query.set("force", "true");
		}
	} else {
		query.delete("dryRun");
	}
	const queryString = query.toString();
	const path = queryString ? `${endpoint}?${queryString}` : endpoint;
	const body =
		action === "update"
			? {
					channel: options.channel,
					dryRun: true,
					force: options.force ?? false,
					version: options.version,
				}
			: { dryRun: true };
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: isQueryAction ? undefined : JSON.stringify(body),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	return pluginPreviewResponse.parse(await resp.json());
}

/** `GET /api/plugins` — list all app manifests merged with their lifecycle state. */
export async function fetchApps(target: ApiTarget): Promise<AppInfo[]> {
	const resp = await fetchForTarget(target)(apiUrl(target, "/api/plugins"), {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins failed: ${resp.status}`);
	}
	const json = pluginManifestEnvelope.parse(await resp.json());
	return (json.apps ?? []).map(toAppInfo);
}

/** One app event an enabled app declares it emits (`contributes.hook_events`),
 *  tagged server-side with its owning `plugin` id. */
export interface HookEventInfo {
	description?: string | null;
	/** Fully-qualified event id: `<owning plugin id>#<event name>` — the exact string
	 *  a workflow's `event` trigger or a plugin hook's `on` must name. */
	id: string;
	payload_example?: AppResponseValue;
	plugin?: string;
	title: string;
}

/** `GET /api/plugins/contributions` → `hook_events` — every app event an ENABLED
 *  app emits. The catalog behind the `event` workflow trigger's picker, so a user
 *  chooses a real event instead of typing a fully-qualified id from memory. */
export async function fetchHookEvents(
	target: ApiTarget
): Promise<HookEventInfo[]> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/plugins/contributions"),
		{
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/plugins/contributions failed: ${resp.status}`);
	}
	const json = pluginHookEnvelope.parse(await resp.json());
	return json.hook_events ?? [];
}

/** `POST /api/plugins/:id/install` — record the app as installed (disabled). */
export async function installApp(
	target: ApiTarget,
	id: string
): Promise<AppRecord> {
	const path = appLifecyclePath(id, "install");
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	const json = pluginRecordEnvelope.parse(await resp.json());
	return toAppRecord(json.app);
}

/** `POST /api/plugins/:id/enable` — validate grants via Gateway then enable app.
 *  Any plugin listed in the manifest's `requires.apps` is auto-enabled first (in
 *  dependency order). Fails closed when the Gateway is unreachable (never silently
 *  falls back) and with a 409 {@link DependencyError} when the graph is
 *  unsatisfiable — nothing is enabled in that case. */
export async function enableApp(
	target: ApiTarget,
	id: string
): Promise<AppRecord> {
	const path = appLifecyclePath(id, "enable");
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	const json = pluginRecordEnvelope.parse(await resp.json());
	return toAppRecord(json.app);
}

/** `POST /api/plugins/:id/disable` — disable app and clear approved grants.
 *
 *  REFUSED with 409 + a `blocked_by_dependents` {@link DependencyError} when other
 *  ENABLED plugins depend on this one; the error names them so the caller can say
 *  "Disable Meetings, Whiteboard first". Pass `{ cascade: true }` to opt into
 *  disabling the whole dependent chain (reverse-topological order) instead. */
export async function disableApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean }
): Promise<AppRecord> {
	const endpoint = appLifecyclePath(id, "disable");
	const path = options?.cascade ? `${endpoint}?cascade=true` : endpoint;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	const json = pluginRecordEnvelope.parse(await resp.json());
	return toAppRecord(json.app);
}

/** The result of a successful `POST /api/plugins/:id/uninstall`. Mirrors Core's
 *  handler body: `{ success, removed, disabled, externally_managed?, notice? }`. */
export interface AppUninstallResult {
	/** Plugins DISABLED as part of the uninstall: the target itself plus, under
	 *  `{ cascade: true }`, its dependents. Cascaded dependents stay
	 *  installed-but-disabled; only the target's lifecycle record is removed. */
	disabled: string[];
	/** Present only when a gateway-enforced policy plugin was toggled against a
	 *  remote/unmanaged gateway: `true` means the change did NOT reach the running
	 *  gateway (a manual restart is required — see {@link notice}). */
	externallyManaged?: boolean;
	/** The restart-the-gateway notice, present only alongside
	 *  `externallyManaged: true`. Show it rather than implying full success. */
	notice?: string;
	/** Id of the plugin whose lifecycle record was removed (the uninstall target). */
	removed: string;
	/** Always `true` on the 2xx path. */
	success: boolean;
}

/** `POST /api/plugins/:id/uninstall` — disable the plugin (and, with
 *  `{ cascade: true }`, its enabled dependents), tear down its runtime
 *  contributions, then remove its lifecycle record.
 *
 *  REFUSED with 409 when other ENABLED plugins depend on this one (a
 *  `blocked_by_dependents` {@link DependencyError}, `dependencyError` set — retry
 *  with `{ cascade: true }`) or when the target is a compiled-in built-in /
 *  default-on plugin (`builtIn: true` on the thrown {@link AppLifecycleError} —
 *  only disable is possible). Both are thrown as a typed, discriminable error. */
export async function uninstallApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean }
): Promise<AppUninstallResult> {
	const endpoint = appLifecyclePath(id, "uninstall");
	const path = options?.cascade ? `${endpoint}?cascade=true` : endpoint;
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	const json = pluginUninstallResponse.parse(await resp.json());
	const result: AppUninstallResult = {
		success: json.success ?? true,
		removed: json.removed ?? id,
		disabled: json.disabled ?? [],
	};
	if (json.externally_managed !== undefined) {
		result.externallyManaged = json.externally_managed;
	}
	if (json.notice !== undefined) {
		result.notice = json.notice;
	}
	return result;
}

/** `POST /api/plugins/:id/update` — update the installed plugin to the manifest
 *  version and return the refreshed lifecycle record.
 *
 *  A DOWNGRADE (the manifest version is older than what is installed) is refused
 *  with 409 unless `{ force: true }` is passed; the thrown
 *  {@link AppLifecycleError} carries Core's `hint` ("pass force=true to override"). */
export async function updateApp(
	target: ApiTarget,
	id: string,
	options?: { force?: boolean }
): Promise<AppRecord> {
	const path = appLifecyclePath(id, "update");
	const resp = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify({ force: options?.force ?? false }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	const json = pluginRecordEnvelope.parse(await resp.json());
	return toAppRecord(json.app);
}
