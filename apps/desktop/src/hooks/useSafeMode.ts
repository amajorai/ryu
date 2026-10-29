import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { restartRyuCore } from "@/lib/tauri-bridge.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applySafeMode,
	fetchSafeMode,
	readSafeModeSentinel,
	type SafeModeState,
} from "@/src/lib/api/safe-mode.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/** Every read and completion belongs to one URL and credential authority. */
export function useSafeMode(target: ApiTarget, pollInterval?: number) {
	const scope = useMemo(
		() => ({
			target: { ...target },
			controller: new AbortController(),
			applying: false,
		}),
		[target.url, target.token, target.userJwt]
	);
	const current = useRef(scope);
	current.current = scope;
	const [result, setResult] = useState<{
		scope: typeof scope;
		state: SafeModeState | null;
		sentinel: boolean | null;
		pending: boolean | null;
		busy: boolean;
	}>();
	const local = isLocalNode(target);
	const owns = useCallback(
		(signal: AbortSignal) => current.current === scope && !signal.aborted,
		[scope]
	);
	const refresh = useCallback(async () => {
		const signal = scope.controller.signal;
		const sentinel = isLocalNode(scope.target)
			? await readSafeModeSentinel()
			: null;
		let state: SafeModeState | null = null;
		try {
			state = await fetchSafeMode(scope.target, signal);
		} catch {
			/* An unreachable node has no effective-state answer. */
		}
		if (owns(signal))
			setResult((old) => ({
				scope,
				state,
				sentinel,
				pending: old?.scope === scope ? old.pending : null,
				busy: old?.scope === scope ? old.busy : false,
			}));
	}, [scope, owns]);
	useEffect(() => {
		scope.controller = new AbortController();
		void refresh();
		const timer = pollInterval ? setInterval(refresh, pollInterval) : undefined;
		return () => {
			scope.controller.abort();
			if (timer) clearInterval(timer);
		};
	}, [scope, refresh, pollInterval]);
	const apply = useCallback(
		async (enabled: boolean) => {
			const signal = scope.controller.signal;
			if (!owns(signal) || scope.applying) return;
			scope.applying = true;
			setResult((old) => ({
				scope,
				state: old?.scope === scope ? old.state : null,
				sentinel: old?.scope === scope ? old.sentinel : null,
				pending: old?.scope === scope ? old.pending : null,
				busy: true,
			}));
			try {
				await applySafeMode(scope.target, enabled, signal);
				if (!owns(signal)) return;
				if (isLocalNode(scope.target)) {
					await restartRyuCore().catch(() => undefined);
					if (owns(signal)) await refresh();
				} else {
					setResult((old) =>
						old?.scope === scope ? { ...old, pending: enabled } : old
					);
				}
			} catch (error) {
				if (owns(signal)) throw error;
			} finally {
				scope.applying = false;
				if (owns(signal))
					setResult((old) =>
						old?.scope === scope ? { ...old, busy: false } : old
					);
			}
		},
		[scope, owns, refresh]
	);
	const visible = result?.scope === scope ? result : undefined;
	return {
		state: visible?.state ?? null,
		sentinel: visible?.sentinel ?? null,
		pending: visible?.pending ?? null,
		busy: visible?.busy ?? false,
		apply,
		local,
	};
}
