// apps/desktop/src/hooks/useLlamacppAcceleration.ts
//
// Which llama.cpp BUILD the node runs: the portable CPU build, or one compiled
// against this machine's GPU (Metal / CUDA / Vulkan). Distinct from the engine
// swap in `useEngines` — that picks *which runtime* is resident, this picks
// which backend that runtime was built for.
//
// The default is `auto`, and almost nobody should have to change it: Core
// detects the hardware and installs the fastest build the machine can actually
// run, falling back to CPU on a machine with no usable graphics card. The
// explicit choices exist for the cases detection can't see — a broken driver, a
// card that OOMs — and Core refuses the GPU builds outright on hardware that
// cannot run them.

import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchLlamacppAcceleration,
	type LlamacppAcceleration,
	setLlamacppAcceleration,
} from "@/src/lib/api/engines.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseLlamacppAccelerationResult {
	acceleration: LlamacppAcceleration | null;
	error: string | null;
	loading: boolean;
	reload: () => Promise<void>;
	/** Pin a build, or `"auto"` to hand the choice back to hardware detection. */
	select: (variant: string) => Promise<void>;
	/** True while Core downloads and installs a newly-chosen build. */
	switching: boolean;
}

export function useLlamacppAcceleration(): UseLlamacppAccelerationResult {
	const activeNode = useActiveNode();
	// Primitives, not the node object: an object literal is a fresh identity on
	// every render, which would make `reload` re-run forever.
	const url = activeNode.url;
	const token = activeNode.token ?? null;
	const userJwt = activeNode.userJwt ?? null;

	const [acceleration, setAcceleration] = useState<LlamacppAcceleration | null>(
		null
	);
	const [loading, setLoading] = useState(true);
	const [switching, setSwitching] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const target: ApiTarget = { url, token, userJwt };
			setAcceleration(await fetchLlamacppAcceleration(target));
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Failed to read the engine's setup"
			);
		} finally {
			setLoading(false);
		}
	}, [url, token, userJwt]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	const select = useCallback(
		async (variant: string) => {
			setSwitching(true);
			setError(null);
			try {
				await setLlamacppAcceleration({ url, token, userJwt }, variant);
				await reload();
			} catch (e) {
				const message =
					e instanceof Error ? e.message : "Could not switch the build";
				// Re-read so the UI shows what is actually installed rather than the
				// choice that failed. Preserve the failed action's message after reload;
				// reload clears its own prior error state while starting the read.
				await reload().catch(() => undefined);
				setError(message);
			} finally {
				setSwitching(false);
			}
		},
		[url, token, userJwt, reload]
	);

	return { acceleration, loading, switching, error, reload, select };
}
