import { Bug01Icon, Idea01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Textarea } from "@ryu/ui/components/textarea";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { FeedbackActions } from "../feedback-host-context.tsx";
import {
	CARD_CLASS,
	type ConsentFollowUp,
	DeliveryRetry,
	errorMessage,
	InlineError,
} from "./consent-cards-shared.tsx";
import { AttachedDetails } from "./feedback-attached-details.tsx";
import {
	clampFeedbackText,
	composeFeedbackReport,
	FEEDBACK_BODY_MAX,
	FEEDBACK_DETAIL_MAX,
	FEEDBACK_TITLE_MAX,
	type FeedbackAttachment,
	type FeedbackDecision,
	type FeedbackDraft,
	type FeedbackKind,
	feedbackFollowUp,
	isSendableDraft,
	readFeedbackDecision,
	writeFeedbackDecision,
} from "./feedback-tool.ts";

/** Sends the user's decision back to the agent as their next message. */
export type FeedbackFollowUp = ConsentFollowUp;

const LABEL_CLASS = "text-muted-foreground text-xs";

function KindIcon({ kind }: { kind: FeedbackKind }) {
	return (
		<HugeiconsIcon
			aria-hidden
			className="size-4"
			icon={kind === "bug" ? Bug01Icon : Idea01Icon}
		/>
	);
}

/** Icon, heading and one quiet line under it. */
export function FeedbackHeader({
	badge,
	kind,
	note,
	title,
}: {
	badge?: ReactNode;
	kind: FeedbackKind;
	note: ReactNode;
	title: string;
}) {
	return (
		<div className="flex items-start gap-2 px-3 pt-3 pb-2">
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
			>
				<KindIcon kind={kind} />
			</span>
			<div className="min-w-0 flex-1">
				<p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
					{title}
					{badge}
				</p>
				<p className="mt-0.5 text-muted-foreground text-xs">{note}</p>
			</div>
		</div>
	);
}

/** A decision whose message to the agent has not been delivered yet. */
interface PendingDelivery {
	decision: FeedbackDecision;
	error: string | null;
	text: string;
}

/**
 * The card's final decision and its delivery to the agent. The decision is
 * remembered only after the follow-up was handed to the chat; if that fails
 * the card keeps a retry, so the agent, which ended its turn to wait, always
 * hears the answer.
 */
function useFeedbackDelivery(
	toolCallId: string | undefined,
	onFollowUp: FeedbackFollowUp
) {
	const [decision, setDecision] = useState<FeedbackDecision | null>(() =>
		readFeedbackDecision(toolCallId)
	);
	const [pending, setPending] = useState<PendingDelivery | null>(null);
	const [delivering, setDelivering] = useState(false);

	const deliver = async (next: FeedbackDecision, text: string) => {
		setDelivering(true);
		setPending({ decision: next, error: null, text });
		try {
			await onFollowUp(text);
			setDecision(next);
			setPending(null);
			writeFeedbackDecision(toolCallId, next);
		} catch (error) {
			setPending({
				decision: next,
				error: errorMessage(error, "Couldn't send your answer to the agent."),
				text,
			});
		} finally {
			setDelivering(false);
		}
	};

	const retry = () =>
		pending ? deliver(pending.decision, pending.text) : null;

	return { decision, deliver, delivering, pending, retry };
}

function DraftField({
	label,
	max,
	onChange,
	value,
}: {
	label: string;
	max: number;
	onChange: (value: string) => void;
	value: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			<label className={LABEL_CLASS} htmlFor={id}>
				{label}
			</label>
			<Textarea
				dir="auto"
				id={id}
				onChange={(event) =>
					onChange(clampFeedbackText(event.target.value, max))
				}
				size="dense"
				value={value}
			/>
		</div>
	);
}

function headingFor(kind: FeedbackKind, tl: LiteralMessage): string {
	return kind === "bug"
		? tl("Report a problem to the Ryu team")
		: tl("Share an idea with the Ryu team");
}

/** The closed card after the report was copied for the feedback board. */
function ThankYou({
	actions,
	boardFailed,
	kind,
	title,
}: {
	actions: FeedbackActions;
	boardFailed: boolean;
	kind: FeedbackKind;
	title: string;
}) {
	const tl = useLiteralMessages();
	const [failed, setFailed] = useState(boardFailed);
	const open = async () => {
		try {
			await actions.openDestination();
			setFailed(false);
		} catch {
			setFailed(true);
		}
	};
	return (
		<>
			<FeedbackHeader
				badge={
					<Badge data-testid="feedback-copied-badge" tone="success">
						<HugeiconsIcon aria-hidden icon={Tick02Icon} />
						Copied
					</Badge>
				}
				kind={kind}
				note={
					<span data-ryu-i18n="off" dir="auto">
						{title}
					</span>
				}
				title={tl("Thank you for your feedback")}
			/>
			<div className="flex flex-wrap items-center justify-between gap-2 border-border border-t px-3 py-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<p className="text-muted-foreground text-xs">
						The report is on your clipboard. Paste it into a new post on the
						feedback board to send it to the Ryu team.
					</p>
					{failed ? (
						<InlineError message={tl("Couldn't open the feedback board.")} />
					) : null}
				</div>
				<Button onClick={open} size="xs" variant="outline">
					Open feedback board
				</Button>
			</div>
		</>
	);
}

/**
 * The actionable feedback card: the agent's draft, editable in place, the
 * lines the app would attach, and the two choices. Nothing leaves the device
 * before the user presses the send button.
 */
export function FeedbackDraftCard({
	actions,
	draft: initialDraft,
	onFollowUp,
	toolCallId,
}: {
	actions: FeedbackActions;
	draft: FeedbackDraft;
	onFollowUp: FeedbackFollowUp;
	/** Keys the remembered decision, so a reopened chat keeps the card closed. */
	toolCallId?: string;
}) {
	const tl = useLiteralMessages();
	const { kind } = initialDraft;
	const [draft, setDraft] = useState(initialDraft);
	const [attachments, setAttachments] = useState<FeedbackAttachment[] | null>(
		null
	);
	const [busy, setBusy] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const [boardFailed, setBoardFailed] = useState(false);
	const { decision, deliver, delivering, pending, retry } = useFeedbackDelivery(
		toolCallId,
		onFollowUp
	);
	const outcome = decision ?? pending?.decision ?? null;
	const closed = outcome !== null;
	const titleId = useId();

	// Read the device details only for a card that can still be sent.
	useEffect(() => {
		if (closed) {
			return;
		}
		let cancelled = false;
		actions
			.collectAttachments(kind)
			.then((lines) => {
				if (!cancelled) {
					setAttachments(lines);
				}
			})
			.catch(() => {
				// Nothing could be read, so nothing is attached. The card says so.
				if (!cancelled) {
					setAttachments([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [actions, closed, kind]);

	const edit = (patch: Partial<FeedbackDraft>) =>
		setDraft((current) => ({ ...current, ...patch }));

	const send = async () => {
		const kept = attachments ?? [];
		const approved: FeedbackDraft = { ...draft, title: draft.title.trim() };
		setBusy(true);
		setSendError(null);
		try {
			const result = await actions.submitFeedback({
				attachments: kept,
				draft: approved,
				report: composeFeedbackReport(approved, kept),
			});
			setBoardFailed(!result.destinationOpened);
		} catch {
			setSendError(tl("Couldn't copy the report. Nothing was sent."));
			setBusy(false);
			return;
		}
		setBusy(false);
		await deliver(
			{ kind: "copied", title: approved.title },
			feedbackFollowUp(kind, "copied")
		);
	};

	const decline = () =>
		deliver({ kind: "declined" }, feedbackFollowUp(kind, "declined"));

	const heading = headingFor(kind, tl);
	let body: ReactNode;
	if (outcome?.kind === "copied") {
		body = (
			<ThankYou
				actions={actions}
				boardFailed={boardFailed}
				kind={kind}
				title={outcome.title}
			/>
		);
	} else if (outcome?.kind === "declined") {
		body = (
			<FeedbackHeader
				kind={kind}
				note={tl("You chose not to send this. Nothing was sent.")}
				title={heading}
			/>
		);
	} else {
		const working = busy || delivering;
		body = (
			<>
				<FeedbackHeader
					kind={kind}
					note={tl(
						"Read the draft and change anything you like. Nothing is sent until you choose to."
					)}
					title={heading}
				/>
				<div className="flex flex-col gap-2 px-3 pb-3">
					<div className="flex flex-col gap-1">
						<label className={LABEL_CLASS} htmlFor={titleId}>
							Title
						</label>
						<Input
							dir="auto"
							id={titleId}
							onChange={(event) =>
								edit({
									title: clampFeedbackText(
										event.target.value,
										FEEDBACK_TITLE_MAX
									),
								})
							}
							size="compact"
							value={draft.title}
						/>
					</div>
					<DraftField
						label={tl("Details")}
						max={FEEDBACK_BODY_MAX}
						onChange={(value) => edit({ body: value })}
						value={draft.body}
					/>
					{initialDraft.steps === null ? null : (
						<DraftField
							label={tl("Steps to reproduce")}
							max={FEEDBACK_DETAIL_MAX}
							onChange={(value) => edit({ steps: value })}
							value={draft.steps ?? ""}
						/>
					)}
					{initialDraft.expected === null ? null : (
						<DraftField
							label={tl("What you expected")}
							max={FEEDBACK_DETAIL_MAX}
							onChange={(value) => edit({ expected: value })}
							value={draft.expected ?? ""}
						/>
					)}
					{initialDraft.actual === null ? null : (
						<DraftField
							label={tl("What happened instead")}
							max={FEEDBACK_DETAIL_MAX}
							onChange={(value) => edit({ actual: value })}
							value={draft.actual ?? ""}
						/>
					)}
					<AttachedDetails
						attachments={attachments}
						onRemove={(id) =>
							setAttachments(
								(current) =>
									current?.filter((attachment) => attachment.id !== id) ?? null
							)
						}
					/>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-2 border-border border-t px-3 py-2">
					<div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
						<p className="text-muted-foreground text-xs">
							Sending copies the report and opens the feedback board in your
							browser, where you post it. The board is public.
						</p>
						{sendError ? <InlineError message={sendError} /> : null}
					</div>
					<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
						<Button
							disabled={working}
							onClick={decline}
							size="xs"
							variant="ghost"
						>
							Not now
						</Button>
						<Button
							disabled={
								working || attachments === null || !isSendableDraft(draft)
							}
							onClick={send}
							size="xs"
						>
							Copy and open feedback board
						</Button>
					</div>
				</div>
			</>
		);
	}

	return (
		<section
			aria-label={heading}
			className={CARD_CLASS}
			data-kind={kind}
			data-state={outcome?.kind ?? "draft"}
			data-testid="feedback-card"
		>
			{body}
			{pending?.error ? (
				<DeliveryRetry
					error={pending.error}
					onRetry={() => retry()}
					sending={delivering}
				/>
			) : null}
		</section>
	);
}

/** Read-only card for chats that can't send feedback or reply to the agent. */
export function FeedbackUnavailableCard({ draft }: { draft: FeedbackDraft }) {
	const tl = useLiteralMessages();
	const heading = headingFor(draft.kind, tl);
	return (
		<section
			aria-label={heading}
			className={CARD_CLASS}
			data-kind={draft.kind}
			data-state="read-only"
			data-testid="feedback-card"
		>
			<FeedbackHeader
				kind={draft.kind}
				note={
					<span data-ryu-i18n="off" dir="auto">
						{draft.title}
					</span>
				}
				title={heading}
			/>
			<p className="border-border border-t px-3 py-2 text-muted-foreground text-xs">
				This chat can't send feedback. Use the feedback option in Ryu's Settings
				instead. Nothing was sent.
			</p>
		</section>
	);
}
