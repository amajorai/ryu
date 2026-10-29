// apps/desktop/src/lib/api/system.ts
//
// Typed client for Core's health and sidecar-status endpoints. Backs the
// `useSystemStatus` hook that drives the shell status indicator (Core up/down,
// active engine, running sidecars).

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { type MeshStatus, normalizeMeshStatus } from "./mesh.ts";
import { meshStatusResponseSchema as systemMeshSchema } from "./mesh-wire.ts";

// Complete current Rust publisher fields; optional known members preserve the
// documented normalization of older omitted probes and SystemInfo's {} error reply.
function systemResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const systemNumber = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const systemText = z.string();
const systemOptionalText = systemText.nullable().optional();
const systemOptionalNumber = systemNumber.nullable().optional();
const systemSidecarSchema = systemResponse(
	z.object({
		name: systemText,
		running: z.boolean(),
		lazy: z.boolean().optional(),
		pid: systemNumber.optional(),
		memory_bytes: systemNumber.optional(),
		cpu_percent: systemNumber.nullable().optional(),
		failure_reason: systemText.optional(),
		sandbox: systemResponse(
			z.object({
				mode: z.enum(["off", "audit", "enforce"]),
				backend: systemText,
				enforced: z.boolean(),
				fs_restricted: z.boolean(),
				detail: systemText.optional(),
			})
		).optional(),
	})
);
const systemFsSchema = systemResponse(
	z.object({
		read: z.array(systemText).optional(),
		write: z.array(systemText).optional(),
	})
);
const systemPermissionSetSchema = systemResponse(
	z.object({
		fs: systemFsSchema.optional(),
		child_process: z.boolean().optional(),
		run: z.array(systemText).optional(),
		network: z.union([z.boolean(), z.array(systemText)]).optional(),
		tool: z.array(systemText).optional(),
	})
);
const systemNativePermissionsSchema = systemResponse(
	z.object({
		name: systemText,
		plugin_id: systemText,
		declared: systemPermissionSetSchema.nullable(),
		enforced: z.boolean(),
	})
);
const systemMissingBinarySchema = systemResponse(
	z.object({
		name: systemText,
		plugin_id: systemText,
		command: systemText,
		expected_asset: systemText,
		reason: systemText,
	})
);
export const sidecarStatusResponseSchema = systemResponse(
	z.object({
		sidecars: z.array(systemSidecarSchema).optional(),
		native_permissions: z.array(systemNativePermissionsSchema).optional(),
		node_runtime: systemOptionalText,
		missing_binaries: z.array(systemMissingBinarySchema).optional(),
	})
);
const systemEngineSchema = systemResponse(
	z.object({
		active: systemOptionalText,
		running: z.boolean().optional(),
		available: z.array(systemText).optional(),
		llamacpp_variant: systemOptionalText,
	})
);
export const systemStatusResponseSchema = systemResponse(
	z.object({
		core: systemResponse(z.object({ reachable: z.boolean() })).optional(),
		engine: systemEngineSchema.optional(),
		sidecars: z.array(systemSidecarSchema).optional(),
		gateway: systemResponse(
			z.object({ reachable: z.boolean().optional() })
		).optional(),
		mesh: systemMeshSchema.nullable().optional(),
	})
);
export const systemHealthResponseSchema = systemResponse(
	z.object({
		status: systemText.optional(),
		version: systemText.optional(),
		gatewayVersion: systemOptionalText,
		requiredRuntimeReady: z.boolean().optional(),
		updateRuntimeNonce: systemOptionalText,
		channel: systemText.optional(),
		capabilities: z.array(systemText).optional(),
	})
);
export const systemInfoResponseSchema = systemResponse(
	z.object({
		hostname: systemOptionalText,
		os: systemText.optional(),
		cpu_name: systemOptionalText,
		cpu_cores: systemOptionalNumber,
		physical_cores: systemOptionalNumber,
		total_ram_bytes: systemOptionalNumber,
		used_ram_bytes: systemOptionalNumber,
		ram_human: systemText.optional(),
		used_ram_human: systemText.optional(),
		total_disk_bytes: systemOptionalNumber,
		used_disk_bytes: systemOptionalNumber,
		disk_human: systemText.optional(),
		used_disk_human: systemText.optional(),
		vram_bytes: systemOptionalNumber,
		vram_human: systemText.optional(),
		gpu_name: systemOptionalText,
		unified_memory: z.boolean().optional(),
		managed: z.boolean().optional(),
		org_id: systemOptionalText,
		org_name: systemOptionalText,
	})
);

export interface HealthResult {
	status: string;
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

/**
 * Fetch the merged system status in one call. Throws if Core is unreachable so
 * the caller maps the failure to "Core down" (clearing the derived slices).
 */
export async function fetchSystemStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SystemStatusSnapshot> {
	const w = await request(
		target,
		"/api/system/status",
		{
			signal,
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
export async function fetchHealth(target: ApiTarget): Promise<HealthResult> {
	const json = await request(
		target,
		"/api/health",
		{},
		systemHealthResponseSchema
	);
	return { status: json.status ?? "ok" };
}

/**
 * Live hardware snapshot for a node (CPU/RAM/disk/GPU). Mirrors Core's
 * `SystemInfo` (`GET /api/system/info`). The numbers describe whichever machine
 * the {@link ApiTarget} points at, so the node selector can show per-node specs.
 */
export interface SystemInfo {
	cpuCores: number | null;
	cpuName: string | null;
	diskHuman: string;
	gpuName: string | null;
	hostname: string | null;
	/** True when this node is a managed (Ryu Cloud) node, pre-provisioned with
	 * provider creds + the credits hook so end users do zero setup (A4 / #501). */
	managed: boolean;
	/** Org this managed node is bound to (after control-plane registration). */
	orgId: string | null;
	orgName: string | null;
	os: string;
	physicalCores: number | null;
	ramHuman: string;
	totalDiskBytes: number | null;
	totalRamBytes: number | null;
	unifiedMemory: boolean;
	usedDiskBytes: number | null;
	usedDiskHuman: string;
	usedRamBytes: number | null;
	usedRamHuman: string;
	vramBytes: number | null;
	vramHuman: string;
}

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
			},
			systemInfoResponseSchema
		)
	);
}

/** Normalize Core's snake_case `SystemInfo` reply (absent fields → defaults). */
export function systemInfoFromWire(
	w: z.output<typeof systemInfoResponseSchema>
): SystemInfo {
	return {
		hostname: w.hostname ?? null,
		os: w.os ?? "",
		cpuName: w.cpu_name ?? null,
		cpuCores: w.cpu_cores ?? null,
		physicalCores: w.physical_cores ?? null,
		totalRamBytes: w.total_ram_bytes ?? null,
		usedRamBytes: w.used_ram_bytes ?? null,
		ramHuman: w.ram_human ?? "",
		usedRamHuman: w.used_ram_human ?? "",
		totalDiskBytes: w.total_disk_bytes ?? null,
		usedDiskBytes: w.used_disk_bytes ?? null,
		diskHuman: w.disk_human ?? "",
		usedDiskHuman: w.used_disk_human ?? "",
		vramBytes: w.vram_bytes ?? null,
		vramHuman: w.vram_human ?? "",
		gpuName: w.gpu_name ?? null,
		unifiedMemory: w.unified_memory ?? false,
		managed: w.managed ?? false,
		orgId: w.org_id ?? null,
		orgName: w.org_name ?? null,
	};
}

/**
 * Fetch per-sidecar running state, normalized to a name->running map.
 * Mirrors the shape used by the services page.
 */
export async function fetchSidecarStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Record<string, boolean>> {
	const json = await request(
		target,
		"/api/sidecar/status",
		{ signal },
		sidecarStatusResponseSchema
	);
	return sidecarRunningMap(json.sidecars);
}

/** Normalize a sidecar list to a name->running map. */
export function sidecarRunningMap(
	sidecars: readonly { name: string; running: boolean }[] | undefined
): Record<string, boolean> {
	const map: Record<string, boolean> = {};
	for (const s of sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}
