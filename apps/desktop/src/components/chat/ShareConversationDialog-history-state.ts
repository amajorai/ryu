import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getHistoryPreview,
	type HistoryPreview,
	saveGitHistory,
	syncGitHistory,
} from "@/src/lib/api/conversation-history.ts";

export function useShareConversationHistory({
	conversationId,
	setError,
	target,
}: {
	conversationId: string;
	setError: (error: string | null) => void;
	target: ApiTarget;
}) {
	const [historyPreview, setHistoryPreview] = useState<HistoryPreview | null>(
		null
	);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [gitSaving, setGitSaving] = useState(false);
	const [gitSaved, setGitSaved] = useState<string | null>(null);
	const [customInput, setCustomInput] = useState("");
	const [appliedTerms, setAppliedTerms] = useState<string[]>([]);
	const draftTerms = useMemo(
		() =>
			customInput
				.split(/\r?\n/)
				.map((term) => term.trim())
				.filter(Boolean),
		[customInput]
	);
	const customDirty =
		JSON.stringify(draftTerms) !== JSON.stringify(appliedTerms);

	const loadPrivacyPreview = useCallback(
		async (terms: string[] = []) => {
			setPreviewLoading(true);
			setPreviewError(null);
			setHistoryPreview(null);
			setGitSaved(null);
			try {
				setHistoryPreview(
					await getHistoryPreview(target, conversationId, terms)
				);
			} catch (previewFailure) {
				setPreviewError(
					previewFailure instanceof Error
						? previewFailure.message
						: "Could not prepare the privacy preview."
				);
			} finally {
				setPreviewLoading(false);
			}
		},
		[conversationId, target]
	);

	const saveToGit = async () => {
		if (!historyPreview?.repoAvailable || customDirty) {
			return;
		}
		setGitSaving(true);
		setError(null);
		try {
			const result = await saveGitHistory(
				target,
				conversationId,
				historyPreview,
				appliedTerms
			);
			setGitSaved(result.checkpoint.checkpointId);
			toast.success(
				result.checkpoint.alreadySaved
					? "Checkpoint is already in Git"
					: "Conversation saved in Git"
			);
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: "Could not save the Git checkpoint."
			);
		} finally {
			setGitSaving(false);
		}
	};

	const pushHistory = async () => {
		if (!historyPreview?.repoRoot || customDirty) {
			return;
		}
		setGitSaving(true);
		setError(null);
		try {
			await syncGitHistory(target, historyPreview.repoRoot, "push");
			toast.success("Conversation history pushed to origin");
		} catch (pushError) {
			setError(
				pushError instanceof Error
					? pushError.message
					: "Could not push Git history."
			);
		} finally {
			setGitSaving(false);
		}
	};

	return {
		appliedTerms,
		customDirty,
		customInput,
		draftTerms,
		gitSaved,
		gitSaving,
		historyPreview,
		loadPrivacyPreview,
		previewError,
		previewLoading,
		pushHistory,
		saveToGit,
		setAppliedTerms,
		setCustomInput,
		setGitSaved,
	};
}

export type ShareConversationHistoryState = ReturnType<
	typeof useShareConversationHistory
>;
