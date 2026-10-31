import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { getRunsSnapshot, subscribeRuns } from "@/src/lib/api/run-store.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface RunSummary {
	agent_id: string | null;
	branch: string | null;
	created_at: number;
	folder_path: string | null;
	id: string;
	message_count: number;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	worktree_path: string | null;
}

/** One credential-scoped feed shared by Layout and all run-history views. */
export function useRuns() {
	const tl = useLiteralMessages();
	// `tl` is a fresh function each render; a stable delegate keeps the
	// subscription (and the shared feed) from churning on every render.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const notificationTl = useCallback<LiteralMessage>(
		(source, values) => tlRef.current(source, values),
		[]
	);
	const { url, token, userJwt } = useActiveNode();
	const target = useMemo(
		() => toTarget({ url, token, userJwt }),
		[url, token, userJwt]
	);
	const subscribe = useCallback(
		(listener: () => void) => subscribeRuns(target, listener, notificationTl),
		[target, notificationTl]
	);
	const snapshot = useCallback(() => getRunsSnapshot(target), [target]);
	const runs = useSyncExternalStore(subscribe, snapshot, snapshot);
	return { runs };
}
