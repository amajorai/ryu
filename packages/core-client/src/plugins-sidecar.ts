// packages/core-client/src/plugins-sidecar.ts
//
// Sidecar control for built-in system apps (Ghost, Shadow).
// Re-exported through `./plugins.ts`.

import { z } from "zod";
import type { AppResponseValue } from "./app-request-json.ts";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";
import {
	type pluginJsonFields,
	pluginJsonObject,
	pluginSidecarEnvelope,
	pluginString,
} from "./plugins-wire.ts";

// ── Sidecar control (system apps: Ghost, Shadow) ──────────────────────────────

/** `GET /api/sidecar/status` — fetch running state for all sidecars as a map.
 *  Used by SystemAppCard to poll whether a built-in sidecar is running. */
export async function fetchSidecarStatus(
	target: ApiTarget
): Promise<Record<string, boolean>> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/sidecar/status"),
		{
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/sidecar/status failed: ${resp.status}`);
	}
	const json = pluginSidecarEnvelope.parse(await resp.json());
	const map: Record<string, boolean> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}

/** `POST /api/setup/:name/install` — download and install a sidecar binary.
 *  Used for built-in system apps before they can be started. */
export async function installSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/api/setup/${name}/install`),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/setup/${name}/install failed: ${resp.status}`);
	}
}

export interface SidecarLifecyclePreview {
	action: "install" | "uninstall";
	dryRun: true;
	name: string;
	success: boolean;
	[key: string]: AppResponseValue;
}

const sidecarPreviewInstallFields = z.object({
	success: z.literal(true),
	dryRun: z.literal(true),
	action: z.literal("install"),
	name: pluginString,
	supported: z.boolean().optional(),
	installed: z.boolean().optional(),
	force: z.boolean().optional(),
	version: pluginString.nullish(),
	writes: z.array(pluginString).optional(),
});
const sidecarPreviewUninstallFields = z.object({
	success: z.literal(true),
	dryRun: z.literal(true),
	action: z.literal("uninstall"),
	name: pluginString,
	removeData: z.boolean().optional(),
	installed: z.boolean().optional(),
	writes: z.array(pluginString).optional(),
});
const sidecarPreviewUnavailableFields = z.object({
	success: z.literal(false),
	error: pluginString,
});
export type SidecarPreviewUnavailable = z.output<
	typeof sidecarPreviewUnavailableFields
>;
const sidecarPreviewReceiptFields = z.union([
	sidecarPreviewInstallFields,
	sidecarPreviewUninstallFields,
	sidecarPreviewUnavailableFields,
]);
const sidecarPreviewResponse = z.custom<
	z.output<typeof sidecarPreviewReceiptFields> &
		z.output<typeof pluginJsonFields>
>(
	(value) =>
		pluginJsonObject.safeParse(value).success &&
		sidecarPreviewReceiptFields.safeParse(value).success
);

export function previewSidecarInstall(
	target: ApiTarget,
	name: string
): Promise<SidecarLifecyclePreview | SidecarPreviewUnavailable> {
	return request(
		target,
		`/api/setup/${encodeURIComponent(name)}/install?dryRun=true`,
		{ method: "POST" },
		sidecarPreviewResponse
	);
}

export function previewSidecarUninstall(
	target: ApiTarget,
	name: string,
	withData = false
): Promise<SidecarLifecyclePreview | SidecarPreviewUnavailable> {
	const route = withData ? "uninstall-with-data" : "uninstall";
	return request(
		target,
		`/api/setup/${encodeURIComponent(name)}/${route}?dryRun=true`,
		{ method: "POST" },
		sidecarPreviewResponse
	);
}

/** `POST /api/sidecar/:name/start` — start a sidecar process. */
export async function startSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/api/sidecar/${name}/start`),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/start failed: ${resp.status}`);
	}
}

/** `POST /api/sidecar/:name/stop` — stop a sidecar process. */
export async function stopSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/api/sidecar/${name}/stop`),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/stop failed: ${resp.status}`);
	}
}
