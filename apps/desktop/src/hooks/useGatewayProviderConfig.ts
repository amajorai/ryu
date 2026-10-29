import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayConfig,
} from "@/src/lib/api/gateway.ts";

type ActiveTarget = Pick<ApiTarget, "url"> &
	Partial<Pick<ApiTarget, "token" | "userJwt">>;

function sameTarget(left: ActiveTarget, right: ApiTarget): boolean {
	return (
		left.url === right.url &&
		(left.token ?? null) === right.token &&
		(left.userJwt ?? null) === right.userJwt
	);
}

export function useGatewayProviderConfig({
	open,
	reachable,
	target,
	getActiveNode,
}: {
	open: boolean;
	reachable: boolean;
	target: ApiTarget;
	getActiveNode: () => ActiveTarget;
}) {
	const boundTarget = useMemo(
		() => ({ url: target.url, token: target.token, userJwt: target.userJwt }),
		[target.url, target.token, target.userJwt]
	);
	const currentNode = useRef(getActiveNode);
	currentNode.current = getActiveNode;
	const request = useRef<AbortController | null>(null);
	const [snapshot, setSnapshot] = useState<{
		target: ApiTarget;
		config: GatewayConfig;
	} | null>(null);
	const refresh = useCallback(async () => {
		request.current?.abort();
		if (
			!(open && reachable && sameTarget(currentNode.current(), boundTarget))
		) {
			return;
		}
		const controller = new AbortController();
		request.current = controller;
		try {
			const config = await fetchGatewayConfig(boundTarget, controller.signal);
			if (
				!controller.signal.aborted &&
				sameTarget(currentNode.current(), boundTarget)
			) {
				setSnapshot({ target: boundTarget, config });
			}
		} catch {
			// Provider edits remain disabled without an authoritative snapshot.
		}
	}, [boundTarget, open, reachable]);
	useEffect(() => {
		setSnapshot(null);
		void refresh();
		return () => request.current?.abort();
	}, [refresh]);
	const config =
		open && reachable && snapshot?.target === boundTarget
			? snapshot.config
			: null;
	return {
		providers: config?.providers ?? null,
		revision: config?.configRevision ?? null,
		refresh,
	};
}
