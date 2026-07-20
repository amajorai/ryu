// apps/desktop/src/lib/api/sandbox.ts
//
// Typed client for Core's sandbox-backend endpoint (`/api/sandbox/backend`).
// A sandbox backend is the isolated runtime the agent's `sandbox_exec` tool runs
// in (wasmtime / docker / microsandbox / opensandbox). Unlike the chat engine,
// backends are NOT mutually exclusive — this picks the *default* used when a call
// omits an explicit backend; a per-call `backend` argument always overrides it.

import { track } from "@/src/lib/analytics.ts";
import { type ApiTarget, request } from "./client.ts";

/** One selectable sandbox backend with its live availability on the node. */
export interface SandboxBackend {
	/** Live probe: is the backend's runtime present on the node right now? */
	detected: boolean;
	displayName: string;
	name: string;
	/** Whether the node's OS/arch can run it at all (false → cannot select). */
	supported: boolean;
}

/** The default backend plus every known backend with availability. */
export interface SandboxBackends {
	/** The current default backend name (used when a call omits `backend`). */
	active: string;
	available: SandboxBackend[];
}

interface SandboxBackendWire {
	detected?: boolean;
	display_name?: string;
	name: string;
	supported?: boolean;
}

export async function fetchSandboxBackends(
	target: ApiTarget
): Promise<SandboxBackends> {
	const json = await request<{
		active?: string;
		available?: SandboxBackendWire[];
	}>(target, "/api/sandbox/backend");
	return {
		active: json.active ?? "wasmtime",
		available: (json.available ?? []).map(
			(b): SandboxBackend => ({
				name: b.name,
				displayName: b.display_name ?? b.name,
				detected: b.detected ?? false,
				supported: b.supported ?? true,
			})
		),
	};
}

/** Set the default sandbox backend. Persists on Core (`~/.ryu/sandbox-backend.json`). */
export async function setSandboxBackend(
	target: ApiTarget,
	name: string
): Promise<string> {
	const json = await request<{
		success?: boolean;
		error?: string;
		active?: string;
	}>(target, "/api/sandbox/backend", { method: "POST", body: { name } });
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to set sandbox backend "${name}"`);
	}
	track({ event: "sandbox_backend_set", backend: name });
	return json.active ?? name;
}
