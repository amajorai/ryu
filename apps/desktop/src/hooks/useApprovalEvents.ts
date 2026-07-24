import { toast } from "@ryu/ui/components/sileo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	type ApprovalEvent,
	streamApprovalEvents,
} from "@/src/lib/api/approvals.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

const RECONNECT_DELAY_MS = 2000;

/** Raise a native OS notification (best-effort; requests permission once). */
function osNotify(title: string, body: string, tag: string): void {
	if (typeof Notification === "undefined") {
		return;
	}
	const show = () => {
		try {
			const n = new Notification(title, { body, tag });
			n.onclick = () => window.focus();
		} catch {
			// Notification construction can throw on some platforms; ignore.
		}
	};
	if (Notification.permission === "granted") {
		show();
	} else if (Notification.permission === "default") {
		Notification.requestPermission()
			.then((perm) => {
				if (perm === "granted") {
					show();
				}
			})
			.catch(() => undefined);
	}
}

/**
 * Subscribe to the Core approval-event SSE stream for the active node. A newly
 * created request raises an in-app toast + a native OS notification so the user
 * can act on a pending decision without hunting for the inbox. Every event
 * refreshes the approval queries. Auto-reconnects on drop and re-subscribes when
 * the active node changes. Mount once high in the tree (the app shell).
 */
export function useApprovalEvents(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const qc = useQueryClient();

	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token };

		const onEvent = (event: ApprovalEvent) => {
			if (event.type === "created") {
				toast.info({
					title: "Approval needed",
					description: event.request.title,
				});
				osNotify(
					"Approval needed",
					event.request.summary,
					`approval-${event.request.id}`
				);
			}
			Promise.resolve(qc.invalidateQueries({ queryKey: ["approvals"] })).catch(
				() => undefined
			);
		};

		const run = async () => {
			while (!cancelled) {
				try {
					await streamApprovalEvents(target, onEvent, controller.signal);
				} catch {
					// Connect/transient failure — fall through to the reconnect delay.
				}
				if (cancelled) {
					break;
				}
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS);
				});
			}
		};
		run().catch(() => undefined);

		return () => {
			cancelled = true;
			controller.abort();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
		};
	}, [url, token, qc]);
}
