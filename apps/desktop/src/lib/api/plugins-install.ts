import type { AppBundle } from "@ryu/app-host/app-bundle";
import type { StandaloneAppBundle } from "@ryu/app-host/standalone";
import type {
	AppRecord,
	AppUninstallResult,
} from "@ryuhq/core-client/plugins.ts";
import {
	type ApiTarget,
	authenticatedFetch,
	buyerTokenHeader,
	makeHeaders,
} from "./client.ts";
import { pluginDocumentSchema } from "./plugin-wire-values.ts";
import { toAppRecord } from "./plugins-app-mappers.ts";
import { fetchApps } from "./plugins-app-queries.ts";
import {
	appRecordEnvelopeSchema,
	grantsEnvelopeSchema,
	parsePluginResponse,
	uninstallEnvelopeSchema,
} from "./plugins-app-response-contracts.ts";
import { nativeErrorStatusSchema } from "./plugins-catalog-response-contracts.ts";
import type { AppInfo, AppToggleResult } from "./plugins-client-types.ts";
import { parseLifecycleError } from "./plugins-lifecycle-errors.ts";

/** `POST /api/plugins/:id/install` — record the app as installed (disabled). */
export async function installApp(
	target: ApiTarget,
	id: string,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppRecord> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/install`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			skipUserJwt: options.skipUserJwt,
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/install`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(appRecordEnvelopeSchema, await resp.json());
	return toAppRecord(json.app);
}

/** Install a standalone app's local manifest/UI carriage through Core's
 * validated install-bundle sink. The app id and UI hash are still validated by
 * Core; the host never writes plugin files directly. */
export async function installStandaloneAppBundle(
	target: ApiTarget,
	bundle: StandaloneAppBundle,
	options: { skipUserJwt?: boolean } = {}
): Promise<void> {
	const manifest = { ...pluginDocumentSchema.parse(bundle.manifest) };
	if (bundle.uiCode !== null) {
		manifest.ui_code = bundle.uiCode;
	}
	const resp = await authenticatedFetch(target, "/api/plugins/install-bundle", {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify(manifest),
		skipUserJwt: options.skipUserJwt,
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/install-bundle");
		throw Object.assign(new Error(err.message), err);
	}
}

/** Install or update a companion-only app that a builder app made (the
 * `apps.installBundle` bridge). The caller has already narrowed the bundle with
 * `checkAppBundle`; Core still validates the manifest and leaves a new install
 * disabled, so the user reviews its grants when enabling it. */
export async function installCompanionAppBundle(
	target: ApiTarget,
	bundle: AppBundle
): Promise<void> {
	const resp = await authenticatedFetch(target, "/api/plugins/install-bundle", {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify(bundle),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/install-bundle");
		throw Object.assign(new Error(err.message), err);
	}
}

/** Install a standalone app through Core's trusted built-in path when available.
 * Built-in manifests retain Core-tier sidecar/MCP authority and their compiled UI
 * seed. A genuinely external app falls back to the local bundle sink instead. */
export async function installStandaloneApp(
	target: ApiTarget,
	id: string,
	bundle: StandaloneAppBundle,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppInfo> {
	try {
		await installApp(target, id, options);
		const installed = (await fetchApps(target, options)).find(
			(app) => app.id === id
		);
		if (installed) {
			return installed;
		}
		throw new Error(`Ryu Core did not register ${id} after built-in install.`);
	} catch (cause) {
		const parsedStatus =
			cause instanceof Error ? nativeErrorStatusSchema.safeParse(cause) : null;
		const status = parsedStatus?.success ? parsedStatus.data.status : undefined;
		if (status !== 404) {
			throw cause;
		}
	}

	await installStandaloneAppBundle(target, bundle, options);
	const installed = (await fetchApps(target, options)).find(
		(app) => app.id === id
	);
	if (!installed) {
		throw new Error(`Ryu Core did not register ${id} after bundle install.`);
	}
	return installed;
}

/** `POST /api/plugins/:id/update` — reinstall an installed plugin at the newest
 *  manifest version from its catalog source. Used by the download center's
 *  "Available updates" section when the installed version trails the catalog. */
export async function updateInstalledPlugin(
	target: ApiTarget,
	id: string,
	/** Switch the install onto another release train and move it to that train's
	 *  current build. Omit to update along the channel the plugin already follows.
	 *
	 *  A switch does not need `force`, even though every prerelease sorts BELOW its
	 *  stable release: Core treats an explicit switch as its own authority and
	 *  reports the version delta back on `channel_switch`. */
	channel?: string | null
): Promise<AppRecord> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/update`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify(channel ? { channel } : {}),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/update`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(appRecordEnvelopeSchema, await resp.json());
	return toAppRecord(json.app);
}

/** Reinstall one exact historical Marketplace version. The explicit `force`
 *  authority is scoped to this user-selected version so Core can safely allow a
 *  downgrade without changing ordinary update semantics. */
export async function updateInstalledPluginAtVersion(
	target: ApiTarget,
	id: string,
	version: string
): Promise<AppRecord> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/update`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ force: true, version }),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/update`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(appRecordEnvelopeSchema, await resp.json());
	return toAppRecord(json.app);
}

/** `POST /api/plugins/:id/enable` — validate grants via Gateway then enable app.
 *  Any plugin listed in the manifest's `requires.apps` is auto-enabled first (in
 *  dependency order). Fails closed when the Gateway is unreachable (never silently
 *  falls back) and with a 409 {@link DependencyError} when the graph is
 *  unsatisfiable — nothing is enabled in that case. */
export async function enableApp(
	target: ApiTarget,
	id: string,
	options: { skipUserJwt?: boolean } = {}
): Promise<AppToggleResult> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/enable`,
		{
			method: "POST",
			// A paid Marketplace plugin re-checks its license with the signed-in
			// account on enable; loopback Core targets only (see buyerTokenHeader).
			headers: {
				...makeHeaders(target.token, target.userJwt),
				...buyerTokenHeader(target),
			},
			skipUserJwt: options.skipUserJwt,
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/enable`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(appRecordEnvelopeSchema, await resp.json());
	return {
		...toAppRecord(json.app),
		externallyManaged: json.externally_managed,
		notice: json.notice,
	};
}

/** `POST /api/plugins/:id/grants` — set an ENABLED app's approved grants to an
 *  explicit subset (per-grant revocation / restore). Escalation-guarded + Gateway-
 *  re-validated Core-side; fails closed if the Gateway is unreachable. Returns the
 *  new approved-grant set. */
export async function setPluginGrants(
	target: ApiTarget,
	id: string,
	grants: string[]
): Promise<string[]> {
	const encodedId = encodeURIComponent(id);
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/${encodedId}/grants`,
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ grants }),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/grants`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(grantsEnvelopeSchema, await resp.json());
	return json.approved_grants ?? [];
}

/** `POST /api/plugins/:id/disable` — disable app and clear approved grants.
 *
 *  REFUSED with 409 + a `blocked_by_dependents` {@link DependencyError} when other
 *  ENABLED plugins depend on this one; the error names them so the UI can say
 *  "Disable Meetings, Whiteboard first". Pass `{ cascade: true }` to opt into
 *  disabling the whole dependent chain (reverse-topological order) instead. */
export async function disableApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean }
): Promise<AppToggleResult> {
	const encodedId = encodeURIComponent(id);
	const path = options?.cascade
		? `/api/plugins/${encodedId}/disable?cascade=true`
		: `/api/plugins/${encodedId}/disable`;
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/disable`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(appRecordEnvelopeSchema, await resp.json());
	return {
		...toAppRecord(json.app),
		externallyManaged: json.externally_managed,
		notice: json.notice,
	};
}

/** `POST /api/plugins/:id/uninstall` — disable the plugin and remove its record.
 *
 *  REFUSED with 409 when it is a built-in (`code:"built_in"` — built-ins can only
 *  be disabled) or has ENABLED dependents (a `blocked_by_dependents`
 *  {@link DependencyError}); pass `{ cascade: true }` to disable the whole dependent
 *  chain first, then remove. The refusal is a typed {@link AppLifecycleError}
 *  (`Object.assign`ed onto the thrown Error), so callers branch on `dependencyError`
 *  vs a plain message exactly as the disable path does.
 *
 *  Core always deletes the app's saved secrets. Its key-value storage is kept
 *  unless `deleteStorage` is set (sent as `{ "delete_storage": true }`). */
export async function uninstallApp(
	target: ApiTarget,
	id: string,
	options?: { cascade?: boolean; deleteStorage?: boolean }
): Promise<AppUninstallResult> {
	const encodedId = encodeURIComponent(id);
	const path = options?.cascade
		? `/api/plugins/${encodedId}/uninstall?cascade=true`
		: `/api/plugins/${encodedId}/uninstall`;
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		...(options?.deleteStorage
			? { body: JSON.stringify({ delete_storage: true }) }
			: {}),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, `/api/plugins/${id}/uninstall`);
		throw Object.assign(new Error(err.message), err);
	}
	const json = parsePluginResponse(uninstallEnvelopeSchema, await resp.json());
	return {
		success: json.success ?? true,
		removed: json.removed ?? id,
		disabled: json.disabled ?? [],
		externallyManaged: json.externally_managed,
		notice: json.notice,
	};
}
