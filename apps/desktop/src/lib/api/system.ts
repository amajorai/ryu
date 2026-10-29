import {
	type SystemInfo,
	sidecarRunningMap,
	sidecarStatusResponseSchema,
	systemHealthResponseSchema,
	systemInfoFromWire,
	systemInfoResponseSchema,
	systemStatusResponseSchema,
} from "@ryuhq/core-client/system.ts";

import { z } from "zod";
// apps/desktop/src/lib/api/system.ts
//
// Typed client for Core's health and sidecar-status endpoints. Backs the
// `useSystemStatus` hook that drives the shell status indicator (Core up/down,
// active engine, running sidecars).

import { type ApiTarget, request } from "./client.ts";
import {
	type MeshStatus,
	normalizeMeshStatus,
	type RawMeshStatus,
} from "./mesh.ts";

export interface HealthResult {
	/** Feature flags the node advertises, for capability-based feature gating. */
	capabilities: string[];
	status: string;
	/** Core's version (CARGO_PKG_VERSION). Null on older nodes that don't report it. */
	version: string | null;
}

/**
 * The merged system-status snapshot from Core (`GET /api/system/status`). Core
 * composes the engine/sidecar/gateway/mesh probes and applies the degrade rules
 * in one place, so every client makes ONE call instead of 4+ and re-deriving the
 * merge. Shadow is NOT included — it is a device-local sensor probed directly.
 */
export interface SystemStatusSnapshot {
	activeEngine: string | null;
	/** True when the status endpoint answered (⇒ Core is reachable). */
	coreReachable: boolean;
	engineRunning: boolean;
	gatewayReachable: boolean;
	/** Normalized mesh status when enabled; null when disabled/absent (neutral). */
	mesh: MeshStatus | null;
	sidecars: Record<string, boolean>;
}

interface SystemStatusWire {
	engine?: { active?: string | null; running?: boolean };
	gateway?: { reachable?: boolean };
	mesh?: RawMeshStatus | null;
	sidecars?: { name: string; running: boolean }[];
}

/**
 * Fetch the merged system status in one call. Throws if Core is unreachable so
 * the caller maps the failure to "Core down" (clearing the derived slices).
 */
export async function fetchSystemStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SystemStatusSnapshot> {
	const w = await request<SystemStatusWire>(
		target,
		"/api/system/status",
		{
			signal,
			skipUserJwt: true,
		},
		systemStatusResponseSchema
	);
	const sidecars = sidecarRunningMap(w.sidecars);
	// Mesh disabled (enabled:false) or absent → null (neutral), matching the
	// per-probe semantics the status spine relied on.
	const meshRaw = w.mesh ?? null;
	const mesh = meshRaw?.enabled ? normalizeMeshStatus(meshRaw) : null;
	return {
		coreReachable: true,
		activeEngine: w.engine?.active ?? null,
		engineRunning: w.engine?.running ?? false,
		sidecars,
		gatewayReachable: w.gateway?.reachable ?? false,
		mesh,
	};
}

/** Probe Core liveness via `/api/health`. Throws if Core is unreachable. */
export async function fetchHealth(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<HealthResult> {
	const json = await request<{
		status?: string;
		version?: string;
		capabilities?: string[];
	}>(
		target,
		"/api/health",
		{
			signal,
			skipUserJwt: true,
			skipAuthentication: true,
		},
		systemHealthResponseSchema
	);
	return {
		status: json.status ?? "ok",
		version: json.version ?? null,
		capabilities: json.capabilities ?? [],
	};
}

/** Live per-node CPU/RAM/disk/GPU snapshot (`GET /api/system/info`). */
export type { SystemInfo };

/** Fetch the node's live CPU/RAM/disk/GPU snapshot. */
export async function fetchSystemInfo(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SystemInfo> {
	return systemInfoFromWire(
		await request(
			target,
			"/api/system/info",
			{
				signal,
				skipUserJwt: true,
			},
			systemInfoResponseSchema
		)
	);
}

/**
 * Restart the managed gateway child (`POST /api/gateway/restart`). Resolves to
 * true when Core respawned it, false when the gateway is externally managed (Core
 * does not own its process) or the restart failed. Never throws for the
 * externally-managed / failure cases — Core answers 200 with `{ success }`.
 */
export async function restartGateway(target: ApiTarget): Promise<boolean> {
	const json = await request<{ success?: boolean }>(
		target,
		"/api/gateway/restart",
		{ method: "POST" },
		z.object({ success: z.boolean().optional() }).passthrough()
	);
	return json.success === true;
}

/**
 * Fetch per-sidecar running state, normalized to a name->running map.
 * Mirrors the shape used by the services page.
 */
export async function fetchSidecarStatus(
	target: ApiTarget
): Promise<Record<string, boolean>> {
	const json = await request<{
		sidecars?: { name: string; running: boolean }[];
	}>(
		target,
		"/api/sidecar/status",
		{ skipUserJwt: true },
		sidecarStatusResponseSchema
	);
	return sidecarRunningMap(json.sidecars);
}
