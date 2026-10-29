/* @jsxImportSource @opentui/react */
// Shares one Core health poller (useCoreHealthPoller) between surfaces, so Home
// and Chat read the same reachability instead of each polling /api/health. It also
// owns the in-TUI "start Core" action: ensureCoreRunning with its progress routed
// to the connection card rather than stderr (which would tear the frame).

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { canBootstrap, ensureCoreRunning } from "./bootstrap.ts";
import { useCore } from "./CoreContext.tsx";
import { type CoreHealth, useCoreHealthPoller } from "./useCoreHealth.ts";

export interface CoreHealthValue extends CoreHealth {
	/** True when "start Core" can act on the active node (local, bootstrap allowed). */
	canStart: boolean;
	/** Start a local Core for the active node, then re-check health. */
	startCore: () => void;
	starting: boolean;
	/** Latest start-Core progress line, or null when idle. */
	startProgress: string | null;
}

const CoreHealthContext = createContext<CoreHealthValue | null>(null);

export function CoreHealthProvider({ children }: { children: ReactNode }) {
	const { target } = useCore();
	const health = useCoreHealthPoller(target);
	const [starting, setStarting] = useState(false);
	// A start message describes one node's attempt: it is shown only for that node
	// and dropped once the node is up.
	const [progress, setProgress] = useState<{
		text: string;
		url: string;
	} | null>(null);
	const canStart = canBootstrap(target.url);
	const { recheck, state } = health;
	const startProgress =
		progress && progress.url === target.url ? progress.text : null;

	useEffect(() => {
		if (state === "up") {
			setProgress(null);
		}
	}, [state]);

	const startCore = useCallback(() => {
		if (starting || !canBootstrap(target.url)) {
			return;
		}
		const startedUrl = target.url;
		setStarting(true);
		setProgress({ text: "Starting Core…", url: startedUrl });
		ensureCoreRunning(target, {
			onProgress: (text) => setProgress({ text, url: startedUrl }),
		})
			.catch(() => undefined)
			.finally(() => {
				// Keep the last progress line: on failure it says why (no binary for
				// this platform, unhealthy after 30s); it clears once Core is up.
				setStarting(false);
				recheck();
			});
	}, [recheck, starting, target]);

	const value = useMemo<CoreHealthValue>(
		() => ({ ...health, canStart, startCore, startProgress, starting }),
		[health, canStart, startCore, startProgress, starting]
	);
	return (
		<CoreHealthContext.Provider value={value}>
			{children}
		</CoreHealthContext.Provider>
	);
}

/** Shared Core health, or null outside CoreHealthProvider (isolated renders). */
export function useCoreHealth(): CoreHealthValue | null {
	return useContext(CoreHealthContext);
}
