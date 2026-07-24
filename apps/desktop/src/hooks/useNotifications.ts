import { toast } from "@ryu/ui/components/sileo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppNotification,
	ackNotification,
	listNotifications,
	markNotificationRead,
} from "@/src/lib/api/notifications.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseNotificationsResult {
	ack: (id: string) => Promise<boolean>;
	acking: string | null;
	error: string | null;
	loading: boolean;
	markRead: (id: string) => Promise<void>;
	/** The signed-in user id used for the feed, or null when signed out. */
	meId: string | null;
	notifications: AppNotification[];
}

/**
 * The signed-in user's app-inbox notifications for the active node. Reads the
 * Better Auth session id (falling back to the local account vault so it works
 * before the session query resolves / offline). Liveness comes from the global
 * `useNotificationEvents` hook, which invalidates the `notifications` query on
 * each SSE ping — mirroring how `useApprovals` stays live via `useApprovalEvents`.
 */
export function useNotifications(): UseNotificationsResult {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;
	const qc = useQueryClient();

	const listQuery = useQuery({
		queryKey: ["notifications", target.url, meId],
		queryFn: () => listNotifications(target, meId as string),
		enabled: meId !== null,
	});

	const invalidate = useCallback(() => {
		Promise.resolve(
			qc.invalidateQueries({ queryKey: ["notifications"] })
		).catch(() => undefined);
	}, [qc]);

	const onError = useCallback((error: unknown) => {
		const message = error instanceof Error ? error.message : "request failed";
		toast.error({ title: "Notifications", description: message });
	}, []);

	const readMutation = useMutation({
		mutationFn: (id: string) => markNotificationRead(target, id),
		onSuccess: invalidate,
		onError,
	});

	const ackMutation = useMutation({
		mutationFn: (id: string) => ackNotification(target, id),
		onSuccess: invalidate,
		onError,
	});

	return {
		notifications: listQuery.data ?? [],
		loading: meId !== null && listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		meId,
		markRead: (id) => readMutation.mutateAsync(id),
		ack: (id) => ackMutation.mutateAsync(id),
		acking:
			ackMutation.isPending && typeof ackMutation.variables === "string"
				? ackMutation.variables
				: null,
	};
}
