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
	const w = await request<SystemStatusWire>(target, "/api/system/status", {
		signal,
	});
	const sidecars: Record<string, boolean> = {};
	for (const s of w.sidecars ?? []) {
		sidecars[s.name] = s.running;
	}
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
	const json = await request<{ status?: string }>(target, "/api/health");
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

interface SystemInfoWire {
	cpu_cores?: number | null;
	cpu_name?: string | null;
	disk_human?: string;
	gpu_name?: string | null;
	hostname?: string | null;
	managed?: boolean;
	org_id?: string | null;
	org_name?: string | null;
	os?: string;
	physical_cores?: number | null;
	ram_human?: string;
	total_disk_bytes?: number | null;
	total_ram_bytes?: number | null;
	unified_memory?: boolean;
	used_disk_bytes?: number | null;
	used_disk_human?: string;
	used_ram_bytes?: number | null;
	used_ram_human?: string;
	vram_bytes?: number | null;
	vram_human?: string;
}

/** Fetch the node's live CPU/RAM/disk/GPU snapshot. */
export async function fetchSystemInfo(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SystemInfo> {
	const w = await request<SystemInfoWire>(target, "/api/system/info", {
		signal,
	});
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
	target: ApiTarget
): Promise<Record<string, boolean>> {
	const json = await request<{
		sidecars?: { name: string; running: boolean }[];
	}>(target, "/api/sidecar/status");
	const map: Record<string, boolean> = {};
	for (const s of json.sidecars ?? []) {
		map[s.name] = s.running;
	}
	return map;
}
