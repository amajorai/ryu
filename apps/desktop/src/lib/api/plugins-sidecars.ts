import {
	type ApiTarget,
	authenticatedFetch,
	makeHeaders,
	request,
} from "./client.ts";
import type { PluginValue } from "./plugin-wire-values.ts";
import { parsePluginResponse } from "./plugins-app-response-contracts.ts";
import {
	engineConcurrencyWireSchema,
	sidecarsEnvelopeSchema,
} from "./plugins-catalog-response-contracts.ts";
import { sidecarLifecyclePreviewResponseCodec } from "./plugins-response-codecs.ts";

// ── Sidecar control (system apps: Ghost, Shadow) ──────────────────────────────

/** `GET /api/sidecar/status` — fetch running state for all sidecars as a map.
 *  Used by SystemAppCard to poll whether a built-in sidecar is running. */
export async function fetchSidecarStatus(
	target: ApiTarget
): Promise<Record<string, boolean>> {
	const resp = await authenticatedFetch(target, "/api/sidecar/status", {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/status failed: ${resp.status}`);
	}
	const json = parsePluginResponse(sidecarsEnvelopeSchema, await resp.json());
	const map: Record<string, boolean> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}

/** Per-sidecar running state plus the resource sample Core attributes to its
 *  resident process. `pid`/`memoryBytes`/`cpuPercent` are absent for engines
 *  with no owned process to sample (adopt-mode / serverless / in-process). */
export interface SidecarDetail {
	cpuPercent: number | null;
	memoryBytes: number | null;
	pid: number | null;
	running: boolean;
	/** OS isolation recorded at the sidecar's last start; null for built-in
	 *  sidecars, never-started ones, and older nodes that do not report it. */
	sandbox: SidecarSandboxStatus | null;
}

/** OS isolation of an app sidecar process, as Core applied it at start. */
export interface SidecarSandboxStatus {
	/** The platform mechanism: `landlock`, `seatbelt`, `job_object`, or `none`. */
	backend: string;
	/** Why the status is what it is when Core fell back (e.g. no Landlock). */
	detail: string | null;
	/** Whether a restriction is actually applied to the process. */
	enforced: boolean;
	/** Whether filesystem access is actually confined. */
	fsRestricted: boolean;
	/** Effective mode after combining the node setting and the manifest. */
	mode: "audit" | "enforce" | "off";
}

/** `GET /api/sidecar/status`, but keeping the per-engine resource fields the
 *  node selector renders (memory/CPU). Same endpoint + poll as
 *  {@link fetchSidecarStatus}; that one stays a plain running-state map for the
 *  many call sites that only need the boolean. */
export async function fetchSidecarDetails(
	target: ApiTarget
): Promise<Record<string, SidecarDetail>> {
	const resp = await authenticatedFetch(target, "/api/sidecar/status", {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/status failed: ${resp.status}`);
	}
	const json = parsePluginResponse(sidecarsEnvelopeSchema, await resp.json());
	const map: Record<string, SidecarDetail> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = {
			running: s.running,
			pid: s.pid ?? null,
			memoryBytes: s.memory_bytes ?? null,
			cpuPercent: s.cpu_percent ?? null,
			sandbox: s.sandbox
				? {
						mode: s.sandbox.mode,
						backend: s.sandbox.backend,
						enforced: s.sandbox.enforced,
						fsRestricted: s.sandbox.fs_restricted,
						detail: s.sandbox.detail ?? null,
					}
				: null,
		};
	}
	return map;
}

/** Live admission-queue + slot depth for the resident local engine. */
export interface EngineConcurrency {
	/** Engine-reported busy slots (llama.cpp `/slots`), when available. */
	engineBusy: number | null;
	engineTotal: number | null;
	/** Requests currently occupying an engine slot (gateway-gated). */
	inFlight: number;
	/** Max concurrent slots the gateway admits (the engine's batch width). */
	maxInFlight: number;
	/** Requests waiting for a slot. */
	queued: number;
	/** Of those waiting, how many are interactive (vs background fan-out). */
	queuedInteractive: number;
}

/** `GET /api/engine/concurrency` — local-engine admission queue + slot depth.
 *  Returns `null` when the gateway/engine reports nothing usable, so callers
 *  can simply hide the caption. */
export async function fetchEngineConcurrency(
	target: ApiTarget
): Promise<EngineConcurrency | null> {
	const resp = await authenticatedFetch(target, "/api/engine/concurrency", {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		return null;
	}
	const json = parsePluginResponse(
		engineConcurrencyWireSchema,
		await resp.json()
	);
	const gate = json.admission?.gates?.[0];
	if (!gate && json.engine_busy_slots == null) {
		return null;
	}
	return {
		inFlight: gate?.in_flight ?? 0,
		maxInFlight: gate?.max_in_flight ?? 0,
		queued: gate?.queued ?? 0,
		queuedInteractive: gate?.queued_interactive ?? 0,
		engineBusy: json.engine_busy_slots ?? null,
		engineTotal: json.engine_total_slots ?? null,
	};
}

/** `POST /api/setup/:name/install` — download and install a sidecar binary.
 *  Used for built-in system apps before they can be started. */
export async function installSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await authenticatedFetch(target, `/api/setup/${name}/install`, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/setup/${name}/install failed: ${resp.status}`);
	}
}

export interface SidecarLifecyclePreview {
	action: "install" | "uninstall";
	dryRun: true;
	name: string;
	success: boolean;
	[key: string]: PluginValue | undefined;
}

export function previewSidecarInstall(
	target: ApiTarget,
	name: string
): Promise<SidecarLifecyclePreview> {
	return request<SidecarLifecyclePreview>(
		target,
		`/api/setup/${encodeURIComponent(name)}/install?dryRun=true`,
		{ method: "POST" },
		sidecarLifecyclePreviewResponseCodec
	);
}

export function previewSidecarUninstall(
	target: ApiTarget,
	name: string,
	withData = false
): Promise<SidecarLifecyclePreview> {
	const route = withData ? "uninstall-with-data" : "uninstall";
	return request<SidecarLifecyclePreview>(
		target,
		`/api/setup/${encodeURIComponent(name)}/${route}?dryRun=true`,
		{ method: "POST" },
		sidecarLifecyclePreviewResponseCodec
	);
}

/** `POST /api/sidecar/:name/start` — start a sidecar process. */
export async function startSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await authenticatedFetch(target, `/api/sidecar/${name}/start`, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/start failed: ${resp.status}`);
	}
}

/** `POST /api/sidecar/:name/stop` — stop a sidecar process. */
export async function stopSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await authenticatedFetch(target, `/api/sidecar/${name}/stop`, {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!resp.ok) {
		throw new Error(`/api/sidecar/${name}/stop failed: ${resp.status}`);
	}
}
