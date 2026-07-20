// apps/desktop/src/lib/api/sandboxes.ts
//
// Typed client for the sandboxes currently running on a node
// (`GET /api/sandboxes`). Each node runs its own Core, and a sandbox is a live
// compute run (wasmtime / Docker / a GPU box on a managed node) executing on
// THAT node, so this asks the node directly via the shared node base-URL + token
// (like connections.ts / system.ts), never the control plane.
//
// Sandbox membership is already org-scoped: a managed (Ryu Cloud) node is bound
// to one org, so "which sandboxes run here" is implicitly "this org's sandboxes
// on this node". No client-side org filter is applied — we render what the node
// returns.
//
// Soft dependency: an older Core without the surface (or an unreachable node)
// 404s / throws, which the caller maps to a hidden section (distinct from an
// empty list, which shows "No sandboxes running").

import { type ApiTarget, request } from "./client.ts";

/** Resource shape a sandbox was provisioned with (normalized to camelCase). */
export interface SandboxSpec {
	/** GPU model when the run has one attached (e.g. "H100"), else null. */
	gpu: string | null;
	/** Memory in GiB, or null when the node doesn't report it. */
	memGib: number | null;
	/** Guest OS label (e.g. "linux"), or null. */
	os: string | null;
	/** Virtual CPU count, or null when the node doesn't report it. */
	vcpu: number | null;
}

/** One sandbox currently running on a node. */
export interface SandboxRun {
	/** Seconds since the run started, for a live mm:ss age. */
	elapsedSeconds: number;
	/** Org the run is billed to, or null on a local (unmanaged) node. */
	orgId: string | null;
	/** Stable run id — the list key. */
	runId: string;
	spec: SandboxSpec;
}

// ── Raw wire shapes (snake_case, as Core emits) ───────────────────────────────

interface RawSandboxSpec {
	gpu?: string | null;
	mem_gib?: number | null;
	os?: string | null;
	vcpu?: number | null;
}

interface RawSandboxRun {
	elapsed_seconds?: number;
	org_id?: string | null;
	run_id?: string;
	spec?: RawSandboxSpec | null;
}

interface RawSandboxes {
	sandboxes?: RawSandboxRun[];
}

function normalizeSpec(raw: RawSandboxSpec | null | undefined): SandboxSpec {
	return {
		vcpu: raw?.vcpu ?? null,
		memGib: raw?.mem_gib ?? null,
		gpu: raw?.gpu ?? null,
		os: raw?.os ?? null,
	};
}

function normalizeRun(raw: RawSandboxRun): SandboxRun {
	return {
		runId: raw.run_id ?? "",
		orgId: raw.org_id ?? null,
		spec: normalizeSpec(raw.spec),
		elapsedSeconds: raw.elapsed_seconds ?? 0,
	};
}

/**
 * Fetch the sandboxes currently running on a node (`GET /api/sandboxes`).
 *
 * Throws on any non-2xx (including 404 on an older Core without the surface) so
 * the caller can distinguish "endpoint absent / node down" (hide the section)
 * from an empty array (show the section with a "No sandboxes running" state).
 */
export async function fetchNodeSandboxes(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SandboxRun[]> {
	const raw = await request<RawSandboxes>(target, "/api/sandboxes", { signal });
	return Array.isArray(raw.sandboxes) ? raw.sandboxes.map(normalizeRun) : [];
}

// ── Persistent sandbox lifecycle (Daytona-only) ───────────────────────────────
//
// A persistent sandbox is a long-lived Daytona workspace: create once, run many
// execs against it, destroy explicitly. It is metered per-second by Core's
// heartbeat (registered on create, deregistered on destroy) and budget-killed if
// it runs over cap. These three write ops are RYU_TOKEN-only on Core, which the
// node bearer in `target.token` already carries — no JWT carve-out needed.

/** A newly created persistent sandbox (normalized to camelCase). */
export interface CreatedSandbox {
	/** Stable run id — pass this to {@link execSandbox} / {@link destroySandbox}. */
	runId: string;
	/** The real Daytona workspace id backing the run. */
	workspaceId: string;
}

/** The result of one `execSandbox` command (normalized to camelCase). */
export interface SandboxExecResult {
	/** Process exit code (0 = success). */
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface RawCreatedSandbox {
	run_id?: string;
	workspace_id?: string;
}

interface RawSandboxExecResult {
	exit_code?: number;
	stderr?: string;
	stdout?: string;
}

/**
 * Create a persistent sandbox on a node (`POST /api/sandboxes`).
 *
 * `budgetMicroUsd` caps the run's spend in micro-USD; omit it to use the node's
 * default run budget. The node provisions with its configured Daytona spec, so
 * no spec is sent from the desktop v1 surface. Throws on any non-2xx.
 */
export async function createSandbox(
	target: ApiTarget,
	opts?: { budgetMicroUsd?: number }
): Promise<CreatedSandbox> {
	const body =
		opts?.budgetMicroUsd === undefined
			? {}
			: { budget_micro_usd: opts.budgetMicroUsd };
	const raw = await request<RawCreatedSandbox>(target, "/api/sandboxes", {
		method: "POST",
		body,
	});
	return {
		runId: raw.run_id ?? "",
		workspaceId: raw.workspace_id ?? "",
	};
}

/**
 * Run a command inside a persistent sandbox
 * (`POST /api/sandboxes/{runId}/exec`). Throws on any non-2xx.
 */
export async function execSandbox(
	target: ApiTarget,
	runId: string,
	req: { args?: string[]; command: string; timeoutSecs?: number }
): Promise<SandboxExecResult> {
	const raw = await request<RawSandboxExecResult>(
		target,
		`/api/sandboxes/${encodeURIComponent(runId)}/exec`,
		{
			method: "POST",
			body: {
				command: req.command,
				args: req.args ?? [],
				timeout_secs: req.timeoutSecs,
			},
		}
	);
	return {
		exitCode: raw.exit_code ?? 0,
		stdout: raw.stdout ?? "",
		stderr: raw.stderr ?? "",
	};
}

/**
 * Destroy a persistent sandbox (`DELETE /api/sandboxes/{runId}`). Idempotent on
 * Core (an already-destroyed run returns success). Throws on any non-2xx.
 */
export async function destroySandbox(
	target: ApiTarget,
	runId: string
): Promise<void> {
	await request<void>(target, `/api/sandboxes/${encodeURIComponent(runId)}`, {
		method: "DELETE",
	});
}
