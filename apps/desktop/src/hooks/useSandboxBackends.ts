// apps/desktop/src/hooks/useSandboxBackends.ts
//
// Backs the Sandboxes group in the Store. A sandbox backend is the isolated
// runtime the agent's `sandbox_exec` tool runs in. Unlike the chat engine, these
// are NOT mutually exclusive — this hook picks the *default* backend (the one
// used when a call omits `backend`); a per-call argument always overrides it.
//
// Reads `/api/sandbox/backend` (the default + each backend's live availability)
// and exposes `select(name)` which POSTs the new default and reloads.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchSandboxBackends,
	type SandboxBackend,
	setSandboxBackend,
} from "@/src/lib/api/sandbox.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** One sandbox backend row: availability + whether it is the current default. */
export interface SandboxBackendEntry extends SandboxBackend {
	/** True when this backend is the current default. */
	isDefault: boolean;
}

export interface UseSandboxBackendsResult {
	backends: SandboxBackendEntry[];
	error: string | null;
	loading: boolean;
	reload: () => Promise<void>;
	/** Make `name` the default backend; resolves once persisted + reloaded. */
	select: (name: string) => Promise<void>;
}

export function useSandboxBackends(): UseSandboxBackendsResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
		}),
		[activeNode.url, activeNode.token]
	);

	const [backends, setBackends] = useState<SandboxBackendEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await fetchSandboxBackends(target);
			setBackends(
				result.available.map((b) => ({
					...b,
					isDefault: b.name === result.active,
				}))
			);
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Failed to load sandbox backends"
			);
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const select = useCallback(
		async (name: string) => {
			await setSandboxBackend(target, name);
			await reload();
		},
		[reload, target]
	);

	return { backends, loading, error, reload, select };
}
