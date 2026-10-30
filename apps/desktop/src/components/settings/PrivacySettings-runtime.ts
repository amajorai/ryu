// apps/desktop/src/components/settings/PrivacySettings-runtime.ts
//
// Node identity, epochs, and the shared mutation runner for the Privacy tab.

import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { apiUrl } from "@/src/lib/api/client.ts";
import {
	type PrivacyMutation,
	trackPrivacyWrite,
} from "./PrivacySettings-writes.ts";

export function usePrivacyRuntime() {
	const activeNode = useActiveNode();
	// Memoize the target so it is stable across renders. A fresh object each
	// render would make the load effect (and every write callback) refire every
	// render, refetching all prefs and clobbering in-progress user input (e.g.
	// the OTLP endpoint field).
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);

	// The same physical API can be selected with a trailing slash. Share pending
	// writes using the shipping URL joiner, while UI epochs retain the full tuple.
	// Missing URLs are reported by the async API reads, not by rendering.
	const physicalResource = target.url.replace(/\/$/, "")
		? apiUrl(target, "")
		: "";
	const identity = JSON.stringify([target.url, target.token, target.userJwt]);
	const scope = useRef({ identity, epoch: 0 });
	const pendingWrites = useRef(new Set<string>());
	if (scope.current.identity !== identity) {
		scope.current = { identity, epoch: scope.current.epoch + 1 };
		pendingWrites.current = new Set();
	}
	const epoch = scope.current.epoch;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const isCurrent = useCallback(
		() => mounted.current && scope.current.epoch === epoch,
		[epoch]
	);
	const [loadedEpoch, setLoadedEpoch] = useState<number | null>(null);
	const [busyKeys, setBusyKeys] = useState<string[]>([]);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [privacyLoadError, setPrivacyLoadError] = useState<string | null>(null);
	const privacyReady = loadedEpoch === epoch;
	const runMutation = useCallback(
		async (
			key: string,
			write: PrivacyMutation,
			optimistic: () => void,
			revert: () => void,
			title: string,
			ready = privacyReady,
			acknowledged?: () => void
		) => {
			if (!(isCurrent() && ready) || pendingWrites.current.has(key)) {
				return;
			}
			pendingWrites.current.add(key);
			setBusyKeys([...pendingWrites.current]);
			optimistic();
			try {
				let writeAcknowledged = false;
				await trackPrivacyWrite(physicalResource, async () => {
					if (!isCurrent()) {
						return;
					}
					await write();
					writeAcknowledged = true;
				});
				if (writeAcknowledged && isCurrent()) {
					acknowledged?.();
				}
			} catch {
				if (!isCurrent()) {
					return;
				}
				revert();
				toast.error(title, {
					description: "Check your connection and try again.",
				});
			} finally {
				if (isCurrent()) {
					pendingWrites.current.delete(key);
					setBusyKeys([...pendingWrites.current]);
				}
			}
		},
		[isCurrent, privacyReady, physicalResource]
	);

	return {
		busyKeys,
		epoch,
		isCurrent,
		loadAttempt,
		mounted,
		pendingWrites,
		physicalResource,
		privacyLoadError,
		privacyReady,
		runMutation,
		setBusyKeys,
		setLoadAttempt,
		setLoadedEpoch,
		setPrivacyLoadError,
		target,
	};
}

export type PrivacyRuntime = ReturnType<typeof usePrivacyRuntime>;
