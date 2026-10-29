import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type DefaultError,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppNotification,
	ackNotification,
	archiveNotification,
	listNotifications,
	markNotificationRead,
	redactConnectSuggestionNotifications,
	unarchiveNotification,
} from "@/src/lib/api/notifications.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { useUserAvailability } from "./useUserAvailability.ts";

export interface UseNotificationsResult {
	ack: (id: string) => Promise<boolean>;
	acking: string | null;
	archive: (id: string) => Promise<void>;
	error: string | null;
	loading: boolean;
	markRead: (id: string) => Promise<void>;
	/** The signed-in user id used for the feed, or null when signed out. */
	meId: string | null;
	notifications: AppNotification[];
	unarchive: (id: string) => Promise<void>;
}

/**
 * The signed-in user's app-inbox notifications for the active node. Reads the
 * Better Auth session id (falling back to the local account vault so it works
 * before the session query resolves / offline). Liveness comes from the global
 * `useNotificationEvents` hook, which invalidates the `notifications` query on
 * each SSE ping — mirroring how `useApprovals` stays live via `useApprovalEvents`.
 *
 * When `archived` is omitted, the hook serves all rows so a surface can compose
 * status and level filters locally. Passing `false` serves the live inbox and
 * `true` serves archived rows. `archive` moves a row to the archive;
 * `unarchive` restores it — both invalidate the feed so the tray and Inbox page
 * stay consistent.
 */
export function useNotifications(archived?: boolean): UseNotificationsResult {
	const { streamingPrivacyActive } = useUserAvailability();
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;
	const qc = useQueryClient();

	const listQuery = useQuery({
		queryKey: ["notifications", target.url, meId, archived ?? "all"],
		queryFn:
			meId === null || meId === undefined
				? skipToken
				: () => listNotifications(target, meId, undefined, archived),
		enabled: meId !== null,
	});

	const invalidate = useCallback(() => {
		Promise.resolve(
			qc.invalidateQueries({ queryKey: ["notifications"] })
		).catch(() => undefined);
	}, [qc]);

	const onError = useCallback((error: DefaultError) => {
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

	const archiveMutation = useMutation({
		mutationFn: (id: string) => archiveNotification(target, id),
		onSuccess: invalidate,
		onError,
	});

	const unarchiveMutation = useMutation({
		mutationFn: (id: string) => unarchiveNotification(target, id),
		onSuccess: invalidate,
		onError,
	});

	return {
		notifications: redactConnectSuggestionNotifications(
			listQuery.data ?? [],
			streamingPrivacyActive
		),
		loading: meId !== null && listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		meId,
		markRead: (id) => readMutation.mutateAsync(id),
		ack: (id) => ackMutation.mutateAsync(id),
		archive: (id) => archiveMutation.mutateAsync(id),
		unarchive: (id) => unarchiveMutation.mutateAsync(id),
		acking:
			ackMutation.isPending && isNativeText(ackMutation.variables)
				? ackMutation.variables
				: null,
	};
}
