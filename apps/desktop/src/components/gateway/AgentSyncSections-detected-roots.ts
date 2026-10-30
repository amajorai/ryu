import { useEffect, useState } from "react";
import { scanAgentSyncRoot } from "@/src/lib/api/agent-sync.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listDirectory } from "@/src/lib/api/workspace.ts";
import {
	HOME_PROVIDERS,
	pathSeparator,
} from "./AgentSyncSections-providers.ts";

/** This node's home directory and which provider homes under it scan cleanly. */
export function useDetectedAgentRoots(target: ApiTarget) {
	const [home, setHome] = useState<string | null>(null);
	const [homeError, setHomeError] = useState<string | null>(null);
	const [homeLoading, setHomeLoading] = useState(true);
	const [homeRetry, setHomeRetry] = useState(0);
	const [detected, setDetected] = useState<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		async function loadDetectedRoots() {
			setHomeLoading(true);
			setHomeError(null);
			try {
				const listing = await listDirectory(target);
				if (cancelled) {
					return;
				}
				setHome(listing.home);
				const separator = pathSeparator(listing.home);
				const candidates = HOME_PROVIDERS.map((entry) => ({
					path: `${listing.home}${separator}${entry.home}`,
					provider: entry.value,
				}));
				const results = await Promise.allSettled(
					candidates.map((candidate) =>
						scanAgentSyncRoot(target, candidate.path, candidate.provider)
					)
				);
				if (cancelled) {
					return;
				}
				setDetected(
					new Set(
						results.flatMap((result, index) =>
							result.status === "fulfilled" ? [candidates[index].path] : []
						)
					)
				);
			} catch (cause) {
				if (!cancelled) {
					setHome(null);
					setHomeError(
						cause instanceof Error
							? cause.message
							: "Could not load this node’s home directory"
					);
				}
			} finally {
				if (!cancelled) {
					setHomeLoading(false);
				}
			}
		}
		void loadDetectedRoots();
		return () => {
			cancelled = true;
		};
	}, [homeRetry, target]);

	return { detected, home, homeError, homeLoading, setDetected, setHomeRetry };
}
