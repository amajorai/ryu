import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type ApiTarget, AppDisabledError } from "@/src/lib/api/client.ts";
import {
	deleteMeeting,
	finalizeMeeting,
	listMeetings,
	type Meeting,
	renameMeeting,
	type StartMeetingInput,
	startMeeting,
} from "@/src/lib/api/meetings.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseMeetingsResult {
	/** Set when Core refused the meetings routes because the Meetings App is
	 *  disabled (`503 app_disabled`). Carries the id to enable + the message. */
	appDisabled: { app: string; message: string } | null;
	deleting: string | null;
	error: string | null;
	finalize: (id: string) => Promise<Meeting>;
	finalizing: string | null;
	loading: boolean;
	meetings: Meeting[];
	remove: (id: string) => Promise<void>;
	rename: (id: string, title: string) => Promise<Meeting>;
	select: (id: string | null) => void;
	selectedId: string | null;
	start: (data?: StartMeetingInput) => Promise<Meeting>;
	starting: boolean;
}

export function useMeetings(): UseMeetingsResult {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const qc = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const listKey = ["meetings", "list", target.url] as const;

	const listQuery = useQuery({
		queryKey: listKey,
		queryFn: () => listMeetings(target),
	});

	const invalidate = useCallback(() => {
		Promise.resolve(qc.invalidateQueries({ queryKey: listKey })).catch(
			() => undefined
		);
	}, [qc, listKey]);

	const startMutation = useMutation({
		mutationFn: (data: StartMeetingInput) => startMeeting(target, data),
		onSuccess: (meeting) => {
			invalidate();
			setSelectedId(meeting.id);
		},
	});

	const finalizeMutation = useMutation({
		mutationFn: (id: string) => finalizeMeeting(target, id),
		onSuccess: invalidate,
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteMeeting(target, id),
		onSuccess: () => {
			invalidate();
			setSelectedId(null);
		},
	});

	const renameMutation = useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			renameMeeting(target, id, title),
		onSuccess: invalidate,
	});

	const appDisabled =
		listQuery.error instanceof AppDisabledError
			? { app: listQuery.error.app, message: listQuery.error.message }
			: null;

	return {
		appDisabled,
		meetings: listQuery.data ?? [],
		loading: listQuery.isLoading,
		// A disabled-app 503 is not a load failure — it has its own actionable
		// surface, so don't also report it as a generic error.
		error:
			appDisabled || !(listQuery.error instanceof Error)
				? null
				: listQuery.error.message,
		selectedId,
		select: setSelectedId,
		start: (data = {}) => startMutation.mutateAsync(data),
		starting: startMutation.isPending,
		finalize: (id) => finalizeMutation.mutateAsync(id),
		finalizing: finalizeMutation.isPending
			? (finalizeMutation.variables ?? null)
			: null,
		remove: (id) => deleteMutation.mutateAsync(id),
		deleting: deleteMutation.isPending
			? (deleteMutation.variables ?? null)
			: null,
		rename: (id, title) => renameMutation.mutateAsync({ id, title }),
	};
}
