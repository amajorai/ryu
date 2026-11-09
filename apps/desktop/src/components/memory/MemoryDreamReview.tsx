import { Refresh01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useState } from "react";
import { useRememberChats } from "@/src/hooks/useRememberChats.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	acceptMemoryProposal,
	type DreamReview,
	type DreamSettings,
	getDreamReview,
	getDreamSettings,
	type MemoryProposal,
	rejectMemoryProposal,
	rollbackMemoryProposal,
	runDreamReview,
	updateDreamSettings,
} from "@/src/lib/api/memory-dream.ts";
import { fetchOrgFeatures } from "@/src/lib/api/org-features.ts";
import { formatLocalDateTime } from "@/src/lib/locale-format.ts";
import { ProposalCard } from "./MemoryDreamProposalCard.tsx";
import { MemoryDreamRecent } from "./MemoryDreamRecent.tsx";
import { MemoryDreamSchedule } from "./MemoryDreamSchedule.tsx";
import {
	MemoryRememberChatsCard,
	MemoryRememberChatsPrompt,
} from "./MemoryRememberChats.tsx";
import {
	dreamSummary,
	type ReviewConflictKind,
	reviewConflictKind,
	undoConflictKind,
} from "./memory-dream-copy.ts";

function formatReviewDate(timestamp: number): string {
	if (!timestamp) {
		return "Not run yet";
	}
	return formatLocalDateTime(timestamp);
}

function reviewConflictDescription(kind: ReviewConflictKind): string {
	switch (kind) {
		case "already_accepted":
			return "It was already accepted elsewhere.";
		case "already_rejected":
			return "It was already rejected elsewhere.";
		case "already_undone":
			return "It was accepted and then undone elsewhere.";
		case "target_deleted":
			return "The memory it changes was deleted, so it was closed automatically.";
		case "target_changed":
			return "The memory it changes was edited or archived since. Reject it, or run Dream again.";
		default:
			return "It was already handled elsewhere.";
	}
}

export function MemoryDreamReview({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const [review, setReview] = useState<DreamReview | null>(null);
	const [settings, setSettings] = useState<DreamSettings>({
		automatic: false,
		quietHoursEnd: 8,
		quietHoursStart: 22,
	});
	const [loading, setLoading] = useState(true);
	const [running, setRunning] = useState(false);
	const [busyProposal, setBusyProposal] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [settingsError, setSettingsError] = useState(false);
	// Core never runs automatic review on an organization-bound node.
	const [managed, setManaged] = useState(false);
	const chats = useRememberChats(target);
	// Core refused the last run (409) because Remember chats is off.
	const [chatsRequired, setChatsRequired] = useState(false);
	const showChatsPrompt = chatsRequired && chats.enabled !== true;

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		const [reviewResult, settingsResult, orgResult] = await Promise.allSettled([
			getDreamReview(target),
			getDreamSettings(target),
			fetchOrgFeatures(target),
		]);
		// An older Core without the route is an unbound node.
		setManaged(orgResult.status === "fulfilled" && orgResult.value.managed);
		if (reviewResult.status === "fulfilled") {
			setReview(reviewResult.value);
		} else {
			setError(reviewResult.reason);
		}
		if (settingsResult.status === "fulfilled") {
			setSettings(settingsResult.value);
			setSettingsError(false);
		} else {
			setSettingsError(true);
		}
		setLoading(false);
	}, [target]);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async () => {
		setRunning(true);
		try {
			const next = await runDreamReview(
				target,
				settings.automatic ? "automatic" : "manual"
			);
			setChatsRequired(false);
			// A run lists new proposals only; keep the undoable ones.
			setReview((current) => ({ ...next, recent: current?.recent ?? [] }));
			toast.success("Dream review ready", {
				description: "Review the proposed memories below before saving them.",
			});
		} catch (nextError) {
			if (nextError instanceof ApiError && nextError.status === 409) {
				// Core's gate is the truth: re-read the opt-in, which may have
				// been turned off from another window, so the prompt can show.
				setChatsRequired(true);
				if ((await chats.reload()) !== false) {
					toast.error("Dream needs Remember chats");
				}
				return;
			}
			setError(nextError);
			toast.error("Dream review couldn't run", {
				description: "Check that this node supports Dream and try again.",
			});
		} finally {
			setRunning(false);
		}
	};

	const enableChats = async () => {
		if (await chats.setEnabled(true)) {
			setChatsRequired(false);
			toast.success("Remember chats is on", {
				description: "Run Dream now to review your recent conversations.",
			});
		} else {
			toast.error("Couldn't turn on Remember chats");
		}
	};

	const saveSettings = async (patch: Partial<DreamSettings>) => {
		const previous = settings;
		setSettings((current) => ({ ...current, ...patch }));
		try {
			setSettings(await updateDreamSettings(target, patch));
		} catch {
			setSettings(previous);
			setSettingsError(true);
			toast.error(
				patch.automatic === undefined
					? "Dream quiet hours couldn't be saved"
					: "Automatic Dream review couldn't be saved"
			);
		}
	};

	// Core refused an Accept or Reject (409): the proposal was handled
	// elsewhere, or the memory it changes was deleted or edited since. Take
	// Core's current queue so the list matches it, and say which.
	const explainReviewConflict = async (
		proposal: MemoryProposal,
		conflict: ApiError,
		action: "accept" | "reject"
	) => {
		const kind = reviewConflictKind(conflict.code);
		let fresh: DreamReview | null = null;
		try {
			fresh = await getDreamReview(target);
		} catch {
			fresh = null;
		}
		setReview((current) => {
			if (fresh) {
				return fresh;
			}
			// Only an edited target leaves the proposal pending.
			return current && kind !== "target_changed"
				? {
						...current,
						proposals: current.proposals.filter(
							(item) => item.id !== proposal.id
						),
					}
				: current;
		});
		toast.error(
			action === "accept"
				? "Couldn't accept this memory"
				: "Couldn't reject this proposal",
			{ description: reviewConflictDescription(kind) }
		);
	};

	const accept = async (proposal: MemoryProposal) => {
		setBusyProposal(proposal.id);
		try {
			await acceptMemoryProposal(target, proposal.id);
			setReview((current) =>
				current
					? {
							...current,
							proposals: current.proposals.filter(
								(item) => item.id !== proposal.id
							),
							recent: [
								{ ...proposal, status: "applied" },
								...current.recent.filter((item) => item.id !== proposal.id),
							],
						}
					: current
			);
			toast.success(
				proposal.operation === "archive" ? "Memory archived" : "Memory accepted"
			);
		} catch (acceptError) {
			if (acceptError instanceof ApiError && acceptError.status === 409) {
				await explainReviewConflict(proposal, acceptError, "accept");
			} else {
				toast.error("Couldn't accept this memory", {
					description: "The proposal is still waiting for review.",
				});
			}
		} finally {
			setBusyProposal(null);
		}
	};

	const reject = async (proposal: MemoryProposal) => {
		setBusyProposal(proposal.id);
		try {
			await rejectMemoryProposal(target, proposal.id);
			setReview((current) =>
				current
					? {
							...current,
							proposals: current.proposals.filter(
								(item) => item.id !== proposal.id
							),
						}
					: current
			);
			toast.success("Proposal rejected");
		} catch (rejectError) {
			if (rejectError instanceof ApiError && rejectError.status === 409) {
				await explainReviewConflict(proposal, rejectError, "reject");
			} else {
				toast.error("Couldn't reject this proposal");
			}
		} finally {
			setBusyProposal(null);
		}
	};

	// Core refused an Undo (409). Take its current list of undoable changes,
	// so one already undone elsewhere disappears, and say why it failed.
	const explainUndoConflict = async (
		proposal: MemoryProposal,
		conflict: ApiError
	) => {
		let recent: MemoryProposal[] | null = null;
		try {
			recent = (await getDreamReview(target)).recent;
		} catch {
			recent = null;
		}
		const kind = undoConflictKind(
			conflict.serverMessage,
			recent ? recent.some((item) => item.id === proposal.id) : null
		);
		setReview((current) => {
			if (!current) {
				return current;
			}
			const listed = recent ?? current.recent;
			return {
				...current,
				recent:
					kind === "gone"
						? listed.filter((item) => item.id !== proposal.id)
						: listed,
			};
		});
		if (kind === "gone") {
			toast.error("This change can't be undone", {
				description: "It was already undone or changed elsewhere.",
			});
		} else if (kind === "deleted") {
			toast.error("Couldn't undo this change", {
				description: "A memory this change touched was deleted since.",
			});
		} else {
			toast.error("Couldn't undo this change", {
				description:
					"A later change builds on this memory. Undo that one first.",
			});
		}
	};

	const undo = async (proposal: MemoryProposal) => {
		setBusyProposal(proposal.id);
		try {
			await rollbackMemoryProposal(target, proposal.id);
			setReview((current) =>
				current
					? {
							...current,
							recent: current.recent.filter((item) => item.id !== proposal.id),
						}
					: current
			);
			toast.success("Change undone", {
				description: "Memory is back to how it was before you accepted it.",
			});
		} catch (undoError) {
			if (undoError instanceof ApiError && undoError.status === 409) {
				await explainUndoConflict(proposal, undoError);
			} else {
				toast.error("Couldn't undo this change", {
					description: "Check the active node connection and try again.",
				});
			}
		} finally {
			setBusyProposal(null);
		}
	};

	return (
		<div className="flex w-full flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-medium text-lg">Dream review</h1>
					<p className="mt-1 max-w-xl text-muted-foreground text-sm">
						Dream looks back at recent conversations and suggests durable
						memories. Nothing is saved until you accept it.
					</p>
				</div>
				<Button disabled={loading} loading={running} onClick={run}>
					{!running && (
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					)}
					{running ? "Reviewing…" : "Run Dream now"}
				</Button>
			</div>

			<MemoryDreamSchedule
				disabled={settingsError}
				managed={managed}
				onChange={(patch) => void saveSettings(patch)}
				settings={settings}
			/>

			<MemoryRememberChatsCard chats={chats} />

			{showChatsPrompt ? (
				<MemoryRememberChatsPrompt
					onEnable={() => void enableChats()}
					saving={chats.saving}
				/>
			) : null}

			{error &&
			error instanceof ApiError &&
			[404, 405, 501].includes(error.status) ? (
				<Empty appearance="bordered">
					<EmptyHeader>
						<EmptyTitle>Dream is not available on this node yet</EmptyTitle>
						<EmptyDescription>
							{tlRich(
								"Update Core to enable review proposals. The desktop is ready for the Dream API at <code>{endpoint}</code>.",
								{ endpoint: "/api/memory/dream/review" },
								{ code: (children) => <code>{children}</code> }
							)}
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => void load()} variant="ghost">
						Try again
					</Button>
				</Empty>
			) : loading ? (
				<SkeletonRows spacing="review" />
			) : error ? (
				<Empty appearance="bordered">
					<EmptyHeader>
						<EmptyTitle>Dream couldn't load</EmptyTitle>
						<EmptyDescription>
							Check the active node connection and try again.
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => void load()} variant="ghost">
						Try again
					</Button>
				</Empty>
			) : review?.proposals.length ? (
				<>
					<div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs">
						<span>{dreamSummary(review, tl)}</span>
						<span>
							{tl("Last run {date}", {
								date: formatReviewDate(review.generatedAt),
							})}
						</span>
					</div>
					<div className="flex flex-col gap-3">
						{review.proposals.map((proposal) => (
							<ProposalCard
								busy={busyProposal === proposal.id}
								key={proposal.id}
								onAccept={accept}
								onReject={reject}
								proposal={proposal}
							/>
						))}
					</div>
				</>
			) : (
				<Empty appearance="bordered">
					<EmptyHeader>
						<EmptyTitle>No new memories to review</EmptyTitle>
						<EmptyDescription>
							Dream will place suggestions here after it reviews your recent
							conversations.
						</EmptyDescription>
					</EmptyHeader>
					<Button disabled={running} onClick={run}>
						<HugeiconsIcon className="size-4" icon={SparklesIcon} />
						Run Dream now
					</Button>
				</Empty>
			)}
			{review && !loading && !error ? (
				<MemoryDreamRecent
					busyProposal={busyProposal}
					onUndo={undo}
					recent={review.recent}
				/>
			) : null}
		</div>
	);
}
