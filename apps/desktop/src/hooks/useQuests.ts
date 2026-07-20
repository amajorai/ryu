import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	acceptSuggestion,
	completeQuest,
	createQuest,
	deleteQuest,
	dismissQuest,
	dismissSuggestion,
	type JudgeResult,
	judgeQuest,
	listQuests,
	type Quest,
	type QuestInput,
	updateQuest,
} from "@/src/lib/api/quests.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseQuestsResult {
	acceptSuggestion: (id: string) => Promise<Quest>;
	complete: (id: string) => Promise<Quest>;
	create: (data: QuestInput) => Promise<Quest>;
	creating: boolean;
	deleting: string | null;
	dismiss: (id: string) => Promise<Quest>;
	dismissSuggestion: (id: string) => Promise<Quest>;
	error: string | null;
	judge: (id: string) => Promise<JudgeResult>;
	judging: string | null;
	loading: boolean;
	quests: Quest[];
	refetch: () => void;
	remove: (id: string) => Promise<void>;
	update: (id: string, data: QuestInput) => Promise<Quest>;
}

export function useQuests(): UseQuestsResult {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const qc = useQueryClient();

	const listKey = ["quests", "list", target.url] as const;

	const listQuery = useQuery({
		queryKey: listKey,
		queryFn: () => listQuests(target),
	});

	const invalidate = useCallback(() => {
		Promise.resolve(qc.invalidateQueries({ queryKey: listKey })).catch(
			() => undefined
		);
	}, [qc, listKey]);

	const refetch = useCallback(() => {
		listQuery.refetch().catch(() => undefined);
	}, [listQuery]);

	const onError = useCallback((error: unknown) => {
		const message = error instanceof Error ? error.message : "request failed";
		sileo.error({ title: "Tasks", description: message });
	}, []);

	const createMutation = useMutation({
		mutationFn: (data: QuestInput) => createQuest(target, data),
		onSuccess: invalidate,
		onError,
	});

	const updateMutation = useMutation({
		mutationFn: ({ id, data }: { id: string; data: QuestInput }) =>
			updateQuest(target, id, data),
		onSuccess: invalidate,
		onError,
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteQuest(target, id),
		onSuccess: invalidate,
		onError,
	});

	const completeMutation = useMutation({
		mutationFn: (id: string) => completeQuest(target, id),
		onSuccess: invalidate,
		onError,
	});

	const dismissMutation = useMutation({
		mutationFn: (id: string) => dismissQuest(target, id),
		onSuccess: invalidate,
		onError,
	});

	const acceptMutation = useMutation({
		mutationFn: (id: string) => acceptSuggestion(target, id),
		onSuccess: invalidate,
		onError,
	});

	const dismissSuggestionMutation = useMutation({
		mutationFn: (id: string) => dismissSuggestion(target, id),
		onSuccess: invalidate,
		onError,
	});

	const judgeMutation = useMutation({
		mutationFn: (id: string) => judgeQuest(target, id),
		onSuccess: invalidate,
		onError,
	});

	return {
		quests: listQuery.data ?? [],
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		create: (data) => createMutation.mutateAsync(data),
		creating: createMutation.isPending,
		update: (id, data) => updateMutation.mutateAsync({ id, data }),
		remove: (id) => deleteMutation.mutateAsync(id),
		deleting: deleteMutation.isPending
			? (deleteMutation.variables ?? null)
			: null,
		complete: (id) => completeMutation.mutateAsync(id),
		dismiss: (id) => dismissMutation.mutateAsync(id),
		acceptSuggestion: (id) => acceptMutation.mutateAsync(id),
		dismissSuggestion: (id) => dismissSuggestionMutation.mutateAsync(id),
		judge: (id) => judgeMutation.mutateAsync(id),
		judging: judgeMutation.isPending ? (judgeMutation.variables ?? null) : null,
		refetch,
	};
}
