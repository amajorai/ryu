import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	listBackgroundProcesses,
	requestStopBackgroundProcess,
} from "@/src/lib/api/background-processes.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

/**
 * The node's background processes, polled for the Background processes row,
 * and the stop action scoped to the node that listed them.
 */
export function usePinnedBackgroundProcesses(target: ApiTarget) {
	const backgroundScope = useMemo(
		() => ({
			target: {
				url: target.url,
				token: target.token ?? null,
				userJwt: target.userJwt ?? null,
			},
		}),
		[target.url, target.token ?? null, target.userJwt ?? null]
	);
	const backgroundScopeRef = useRef(backgroundScope);
	backgroundScopeRef.current = backgroundScope;
	const backgroundMountedRef = useRef(false);
	useEffect(() => {
		backgroundMountedRef.current = true;
		return () => {
			backgroundMountedRef.current = false;
		};
	}, []);
	const backgroundQueryClient = useQueryClient();
	const backgroundQueryKey = [
		"background-processes",
		backgroundScope.target.url,
		backgroundScope.target.token,
		backgroundScope.target.userJwt,
	];
	const backgroundAuthorityKey = JSON.stringify(backgroundQueryKey);
	const backgroundPendingRef = useRef(new Map<string, string>());
	const [, setBackgroundPendingRevision] = useState(0);
	const stoppingProcessId =
		backgroundPendingRef.current.get(backgroundAuthorityKey) ?? null;
	const [backgroundFailure, setBackgroundFailure] = useState<{
		scope: typeof backgroundScope;
		message: string;
	} | null>(null);
	const backgroundError =
		backgroundFailure?.scope === backgroundScope
			? backgroundFailure.message
			: null;
	const backgroundProcessesQuery = useQuery({
		enabled: Boolean(backgroundScope.target.url),
		queryFn: () => listBackgroundProcesses(backgroundScope.target),
		queryKey: backgroundQueryKey,
		refetchInterval: 1000,
		retry: false,
		staleTime: 0,
	});
	const backgroundProcesses = backgroundProcessesQuery.data ?? [];

	const handleStopBackgroundProcess = async (processId: string) => {
		const scope = backgroundScope;
		if (
			backgroundScopeRef.current !== scope ||
			backgroundPendingRef.current.has(backgroundAuthorityKey)
		) {
			return;
		}
		const ownsScope = () =>
			backgroundMountedRef.current && backgroundScopeRef.current === scope;
		backgroundPendingRef.current.set(backgroundAuthorityKey, processId);
		setBackgroundPendingRevision((revision) => revision + 1);
		setBackgroundFailure(null);
		try {
			await requestStopBackgroundProcess(scope.target, processId);
		} catch (error) {
			if (ownsScope()) {
				setBackgroundFailure({
					scope,
					message:
						error instanceof Error ? error.message : "Could not stop process.",
				});
			}
		} finally {
			backgroundPendingRef.current.delete(backgroundAuthorityKey);
			// Refresh the acknowledged authority even if the user left and returned;
			// never refresh or change the controls of a different authority.
			await backgroundQueryClient.invalidateQueries({
				queryKey: backgroundQueryKey,
				exact: true,
			});
			if (backgroundMountedRef.current) {
				setBackgroundPendingRevision((revision) => revision + 1);
			}
		}
	};
	return {
		backgroundError,
		backgroundProcesses,
		handleStopBackgroundProcess,
		stoppingProcessId,
	};
}
