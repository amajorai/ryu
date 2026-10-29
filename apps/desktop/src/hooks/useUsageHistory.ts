import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchUsageHistory,
	fetchUsageHistoryTracking,
	type HistoryAccountSyncRequest,
	type HistoryImportReport,
	type HistoryImportRequest,
	type HistoryScope,
	importUsageHistory,
	setUsageHistoryTracking,
	syncUsageHistoryAccount,
} from "@/src/lib/api/usage-history.ts";

function message<TError>(error: TError): string {
	if (error instanceof ApiError) {
		return error.status === 404
			? "Update this node to use historical usage imports."
			: (error.serverMessage ?? error.message);
	}
	return error instanceof Error
		? error.message
		: "Unable to read usage history.";
}

interface OperationState {
	error: string | null;
	identity: string;
	nextCursor: string | null;
	pending: boolean;
	report: HistoryImportReport | null;
}

export function useUsageHistory(
	target: ApiTarget,
	days: number | null,
	scope: HistoryScope = "session"
) {
	const active = useIsActiveTab();
	const queryClient = useQueryClient();
	const instance = useId();
	const targetRevision = useHistoryTargetRevision(target);
	const identity = `${instance}:${target.url}:${targetRevision}`;
	const key = useMemo(
		() => ["usage-history", identity, days, scope],
		[identity, days, scope]
	);
	const startDate =
		days === null
			? undefined
			: new Date(Date.now() - (days - 1) * 86_400_000)
					.toISOString()
					.slice(0, 10);
	const query = useQuery({
		enabled: active,
		queryKey: key,
		queryFn: ({ signal }) =>
			fetchUsageHistory(target, startDate, signal, scope),
		staleTime: 60_000,
	});
	const tracking = useQuery({
		enabled: active,
		queryKey: ["usage-history-tracking", identity],
		queryFn: ({ signal }) => fetchUsageHistoryTracking(target, signal),
	});
	const [state, setState] = useState<OperationState | null>(null);
	const [trackingState, setTrackingState] = useState<{
		identity: string;
		pending: boolean;
		error: string | null;
	} | null>(null);
	const operation = useRef<AbortController | null>(null);
	const trackingOperation = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			operation.current?.abort();
			operation.current = null;
			trackingOperation.current?.abort();
			trackingOperation.current = null;
		},
		[identity]
	);
	const refresh = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: ["usage-history", identity],
		});
	}, [identity, queryClient]);
	const run = useCallback(
		async (body: HistoryImportRequest | HistoryAccountSyncRequest) => {
			if (operation.current) {
				return;
			}
			const controller = new AbortController();
			operation.current = controller;
			setState({
				identity,
				pending: true,
				report: null,
				error: null,
				nextCursor: null,
			});
			try {
				const result =
					"credential" in body
						? await syncUsageHistoryAccount(target, body, controller.signal)
						: {
								report: await importUsageHistory(
									target,
									body,
									controller.signal,
									(report) => {
										if (!controller.signal.aborted) {
											setState({
												identity,
												pending: true,
												error: null,
												report,
												nextCursor: null,
											});
										}
									}
								),
								nextCursor: null,
							};
				if (controller.signal.aborted) {
					return;
				}
				await queryClient.invalidateQueries({
					queryKey: ["usage-history", identity],
				});
				if (!controller.signal.aborted) {
					setState({ identity, pending: false, error: null, ...result });
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					setState({
						identity,
						pending: false,
						report: null,
						error: message(error),
						nextCursor: "cursor" in body ? (body.cursor ?? null) : null,
					});
				}
			} finally {
				if (operation.current === controller) {
					operation.current = null;
				}
			}
		},
		[identity, queryClient, target]
	);
	const toggleTracking = useCallback(
		async (enabled: boolean) => {
			if (trackingOperation.current) {
				return;
			}
			const controller = new AbortController();
			trackingOperation.current = controller;
			setTrackingState({ identity, pending: true, error: null });
			try {
				const result = await setUsageHistoryTracking(
					target,
					enabled,
					controller.signal
				);
				if (!controller.signal.aborted) {
					queryClient.setQueryData(
						["usage-history-tracking", identity],
						result
					);
					setTrackingState({ identity, pending: false, error: null });
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					setTrackingState({ identity, pending: false, error: message(error) });
				}
			} finally {
				if (trackingOperation.current === controller) {
					trackingOperation.current = null;
				}
			}
		},
		[identity, queryClient, target]
	);
	const current = state?.identity === identity ? state : null;
	const currentTracking =
		trackingState?.identity === identity ? trackingState : null;
	return {
		report: query.data ?? null,
		loading: query.isLoading,
		refreshing: query.isFetching,
		error: query.error ? message(query.error) : null,
		refresh,
		runImport: run,
		syncAccount: run,
		importing: current?.pending ?? false,
		importReport: current?.report ?? null,
		importError: current?.error ?? null,
		nextCursor: current?.nextCursor ?? null,
		trackingEnabled: tracking.data?.enabled ?? false,
		trackingAvailable: Boolean(tracking.data),
		trackingUpdating: currentTracking?.pending ?? false,
		trackingError:
			currentTracking?.error ??
			(tracking.error ? message(tracking.error) : null),
		toggleTracking,
	};
}

/** Credentials stay in this private memo; only the opaque revision enters cache keys. */
export function useHistoryTargetRevision(target: ApiTarget): string {
	return useMemo(
		() => ({
			url: target.url,
			token: target.token,
			userJwt: target.userJwt ?? null,
			revision: crypto.randomUUID(),
		}),
		[target.url, target.token, target.userJwt]
	).revision;
}
