import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	type ApprovalEvent,
	type ApprovalRequest,
	streamApprovalEvents,
} from "@/src/lib/api/approvals.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	resolveNotificationSender,
	showOsNotification,
} from "@/src/lib/notifications/os-notify.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { useUserAvailability } from "./useUserAvailability.ts";

/** Raise an OS notification from the requesting agent (no-op when disabled). */
function osNotify(
	request: ApprovalRequest,
	isCurrent: () => boolean,
	tl: LiteralMessage
): void {
	if (!isCurrent()) {
		return;
	}
	resolveNotificationSender(request.agent_id)
		.then((sender) =>
			showOsNotification({
				title: sender
					? tl("{name} needs your approval", { name: sender.name })
					: "Approval needed",
				body: request.summary,
				tag: `approval-${request.id}`,
				sender,
			})
		)
		.catch(() => undefined);
}

/**
 * Subscribe to the Core approval-event SSE stream for the active node. A newly
 * created request raises an in-app toast + a native OS notification while the
 * user is Online, so Away and Do not disturb do not interrupt them. Every event
 * refreshes the approval queries, as does every reconnect of the shared stream.
 * Auto-reconnects on drop and re-subscribes when the active node changes. Mount
 * once high in the tree (the app shell).
 */
export function useApprovalEvents(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const authority = useMemo(() => ({}), [url, token, userJwt]);
	const currentAuthority = useRef(authority);
	currentAuthority.current = authority;
	const qc = useQueryClient();
	const { status } = useUserAvailability();
	const statusRef = useRef(status);
	statusRef.current = status;
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;

	useEffect(() => {
		const controller = new AbortController();
		const target: ApiTarget = { url, token, userJwt };

		const refreshApprovals = () => {
			Promise.resolve(qc.invalidateQueries({ queryKey: ["approvals"] })).catch(
				() => undefined
			);
		};

		const onEvent = (event: ApprovalEvent) => {
			if (event.type === "created" && statusRef.current === "online") {
				toast.info({
					title: "Approval needed",
					description: event.request.title,
				});
				osNotify(
					event.request,
					() =>
						currentAuthority.current === authority &&
						!controller.signal.aborted,
					tlRef.current
				);
			}
			refreshApprovals();
		};

		// `streamApprovalEvents` is backed by the shared event multiplexer, which
		// owns reconnect/backoff for every channel on this node. Requests created
		// while it was reconnecting are never replayed, so refetch (without a
		// toast) whenever it re-opens.
		streamApprovalEvents(
			target,
			onEvent,
			controller.signal,
			refreshApprovals
		).catch(() => undefined);

		return () => {
			controller.abort();
		};
	}, [url, token, userJwt, authority, qc]);
}
