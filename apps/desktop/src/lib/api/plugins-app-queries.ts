import type { AppLifecycleAction } from "@ryuhq/core-client/plugins.ts";
import {
	type ApiTarget,
	authenticatedFetch,
	identityHeaders,
	makeHeaders,
	request,
} from "./client.ts";
import { pluginRecord, pluginStringField } from "./plugin-wire-values.ts";
import { toAppInfo } from "./plugins-app-mappers.ts";
import {
	appLifecyclePreviewResponseSchema,
	appsEnvelopeSchema,
	evalsOverviewSchema,
	parsePluginResponse,
	pluginDoctorReportResponseSchema,
	pluginEvalRunResultResponseSchema,
} from "./plugins-app-response-contracts.ts";
import type {
	AppInfo,
	AppLifecycleCapabilities,
	AppLifecyclePreview,
	PluginDoctorReport,
	PluginEvalOverview,
	PluginEvalRunInput,
	PluginEvalRunResult,
} from "./plugins-client-types.ts";
import { parseLifecycleError } from "./plugins-lifecycle-errors.ts";
import { appLifecycleCapabilitiesResponseCodec } from "./plugins-response-codecs.ts";

// ── Public API ────────────────────────────────────────────────────────────────

/** `GET /api/plugins` — list all app manifests merged with their lifecycle state.
 *  Sends `identityHeaders()` (which carries `X-Ryu-Surface: desktop`) so Core
 *  filters the list to plugins that target this surface — the direct-fetch path
 *  otherwise omits it, leaving `targets` inert. */
export async function fetchApps(
	target: ApiTarget,
	options: { skipUserJwt?: boolean; signal?: AbortSignal } = {}
): Promise<AppInfo[]> {
	const resp = await authenticatedFetch(target, "/api/plugins", {
		method: "GET",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...identityHeaders(),
		},
		skipUserJwt: options.skipUserJwt,
		signal: options.signal,
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins failed: ${resp.status}`);
	}
	const json = parsePluginResponse(appsEnvelopeSchema, await resp.json());
	return (json.apps ?? []).map(toAppInfo);
}

/** `GET /api/plugins/lifecycle-capabilities` — advisory node-scoped lifecycle
 *  projection for desktop controls. Mutating calls still re-check the server
 *  permission immediately before touching the installed package. */
export async function fetchAppLifecycleCapabilities(
	target: ApiTarget
): Promise<AppLifecycleCapabilities> {
	return request<AppLifecycleCapabilities>(
		target,
		"/api/plugins/lifecycle-capabilities",
		undefined,
		appLifecycleCapabilitiesResponseCodec
	);
}

/** Validate and plan an app/plugin lifecycle change without changing Core,
 *
 *  The plan is deliberately not returned as an AppRecord: a dry run is a
 *  projection, never proof that the requested state was persisted. */
export async function previewAppLifecycle(
	target: ApiTarget,
	id: string,
	action: AppLifecycleAction,
	options: {
		cascade?: boolean;
		channel?: string;
		force?: boolean;
		skipUserJwt?: boolean;
		version?: string;
	} = {}
): Promise<AppLifecyclePreview> {
	const encodedId = encodeURIComponent(id);
	const query = new URLSearchParams();
	const queryAction = action === "disable" || action === "uninstall";
	if (queryAction) {
		query.set("dryRun", "true");
		if (options.cascade) {
			query.set("cascade", "true");
		}
		if (options.force) {
			query.set("force", "true");
		}
	}
	const queryString = query.toString();
	const suffix = queryString ? `?${queryString}` : "";
	const path = `/api/plugins/${encodedId}/${action}${suffix}`;
	const body =
		action === "update"
			? {
					channel: options.channel,
					dryRun: true,
					force: options.force ?? false,
					version: options.version,
				}
			: { dryRun: true };
	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: queryAction ? undefined : JSON.stringify(body),
		skipUserJwt: options.skipUserJwt,
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, path);
		throw Object.assign(new Error(err.message), err);
	}
	return parsePluginResponse(
		appLifecyclePreviewResponseSchema,
		await resp.json()
	);
}

/** Run the read-only Core loader/lifecycle doctor for installed apps/plugins. */
export async function fetchPluginDoctor(
	target: ApiTarget,
	id?: string
): Promise<PluginDoctorReport> {
	const suffix = id ? `?id=${encodeURIComponent(id)}` : "";
	const resp = await authenticatedFetch(
		target,
		`/api/plugins/doctor${suffix}`,
		{
			method: "GET",
			headers: {
				...makeHeaders(target.token, target.userJwt),
				...identityHeaders(),
			},
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/plugins/doctor failed: ${resp.status}`);
	}
	return parsePluginResponse(
		pluginDoctorReportResponseSchema,
		await resp.json()
	);
}

/** Inspect the Claude-compatible package eval suite without executing it. */
export async function fetchPluginEvals(
	target: ApiTarget,
	id?: string
): Promise<PluginEvalOverview | { plugins: PluginEvalOverview[] }> {
	const suffix = id ? `?id=${encodeURIComponent(id)}` : "";
	const resp = await authenticatedFetch(target, `/api/plugins/evals${suffix}`, {
		method: "GET",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...identityHeaders(),
		},
	});
	if (!resp.ok) {
		throw new Error(`/api/plugins/evals failed: ${resp.status}`);
	}
	return parsePluginResponse(evalsOverviewSchema, await resp.json());
}

/** Run an installed plugin/app eval suite through Core's normal agent path. */
export async function runPluginEvals(
	target: ApiTarget,
	input: PluginEvalRunInput
): Promise<PluginEvalRunResult> {
	const resp = await authenticatedFetch(target, "/api/plugins/evals/run", {
		method: "POST",
		headers: {
			...makeHeaders(target.token, target.userJwt),
			...identityHeaders(),
		},
		body: JSON.stringify(input),
	});
	const payload = await resp.json().catch(() => null);
	if (!resp.ok) {
		const error = pluginRecord(pluginRecord(payload)?.error);
		throw new Error(
			pluginStringField(error?.message) ??
				`/api/plugins/evals/run failed: ${resp.status}`
		);
	}
	return parsePluginResponse(pluginEvalRunResultResponseSchema, payload);
}
