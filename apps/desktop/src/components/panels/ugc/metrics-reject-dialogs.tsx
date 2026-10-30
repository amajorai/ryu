import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useState } from "react";
import type {
	MetricSnapshotView as MetricSnapshot,
	SubmissionView as Submission,
} from "../ugc-wire-contracts.ts";
import {
	describeError,
	formatDate,
	parseCount,
	useUgcCall,
} from "./ugc-format.ts";
import { ErrorBanner, PostLink } from "./ugc-primitives.tsx";

/** The five counters one snapshot carries, in the order an operator reads them
 *  off a platform's own analytics page. */
const METRIC_FIELDS = [
	{ key: "views", label: "Views" },
	{ key: "likes", label: "Likes" },
	{ key: "comments", label: "Comments" },
	{ key: "shares", label: "Shares" },
	{ key: "saves", label: "Saves" },
] as const;

type MetricField = (typeof METRIC_FIELDS)[number]["key"];
type MetricDraft = Record<MetricField, string>;
type MetricCounts = Record<MetricField, number>;

function draftFromSnapshot(latest: MetricSnapshot | null | undefined) {
	return {
		comments: String(latest?.comments ?? 0),
		likes: String(latest?.likes ?? 0),
		saves: String(latest?.saves ?? 0),
		shares: String(latest?.shares ?? 0),
		views: String(latest?.views ?? 0),
	};
}

/** All five counters, or null if any box is not a whole number. Parsed as a set
 *  rather than field by field because the POST writes a whole snapshot — a body
 *  assembled from the boxes that happened to parse would store zeros for the
 *  ones that did not. */
function parseDraft(draft: MetricDraft): MetricCounts | null {
	const views = parseCount(draft.views);
	const likes = parseCount(draft.likes);
	const comments = parseCount(draft.comments);
	const shares = parseCount(draft.shares);
	const saves = parseCount(draft.saves);
	if (
		views === null ||
		likes === null ||
		comments === null ||
		shares === null ||
		saves === null
	) {
		return null;
	}
	return { comments, likes, saves, shares, views };
}

/** Enter a post's counters by hand.
 *
 *  This is the app's floor: it is the ONLY way to get metrics onto a platform
 *  the sidecar curates no Composio source for, and the correction path when an
 *  automated read is wrong — so it is offered whether or not Composio is
 *  connected on this node.
 *
 *  `POST /submissions/{id}/metrics` APPENDS a snapshot; it does not patch the
 *  previous one, and every counter absent from the body defaults to 0 in the
 *  sidecar's `MetricsBody`. The form therefore prefills from the newest reading
 *  and always sends all five: posting only the edited box would silently zero
 *  the other four, and the accrual that runs right after would re-price this
 *  post off those zeros. */
export function RecordMetricsDialog({
	onClose,
	onRecorded,
	submission,
}: {
	onClose: () => void;
	onRecorded: () => void;
	submission: Submission;
}) {
	const tl = useLiteralMessages();
	const call = useUgcCall();
	const [draft, setDraft] = useState<MetricDraft>(() =>
		draftFromSnapshot(submission.latest)
	);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const submissionId = submission.id;

	const submit = useCallback(async () => {
		setError(null);
		const counts = parseDraft(draft);
		if (counts === null) {
			setError("Every counter must be a whole number, e.g. 12000. Blank is 0.");
			return;
		}
		setSaving(true);
		try {
			await call(`/submissions/${encodeURIComponent(submissionId)}/metrics`, {
				body: JSON.stringify(counts),
				method: "POST",
			});
			onRecorded();
		} catch (err) {
			// A negative counter is a 400 and an unknown row a 404, both in the
			// sidecar's own wording. The dialog stays open showing it — a failed
			// write must never look like a recorded one.
			setError(describeError(err));
		} finally {
			setSaving(false);
		}
	}, [call, draft, onRecorded, submissionId]);

	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Record metrics</DialogTitle>
					<DialogDescription>
						Appends a reading to this post and re-runs its accrual. The boxes
						start at the newest reading, so correcting one leaves the rest as
						they were.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<PostLink url={submission.post_url} />
					<div className="grid grid-cols-2 gap-2">
						{METRIC_FIELDS.map((field) => (
							<div className="flex flex-col gap-1.5" key={field.key}>
								<Label htmlFor={`ugc-metric-${field.key}`}>{field.label}</Label>
								<Input
									id={`ugc-metric-${field.key}`}
									inputMode="numeric"
									onChange={(e) =>
										setDraft((prev) => ({
											...prev,
											[field.key]: e.target.value,
										}))
									}
									value={draft[field.key]}
								/>
							</div>
						))}
					</div>
					{submission.latest ? (
						<p className="text-muted-foreground text-xs">
							{tl(
								"Newest reading {date}, {source, select, composio {read through Composio} other {entered by hand}}.",
								{
									date: formatDate(submission.latest.captured_at),
									source:
										submission.latest.source === "composio"
											? "composio"
											: "other",
								}
							)}
						</p>
					) : (
						<p className="text-muted-foreground text-xs">
							No reading on this post yet — these are the first.
						</p>
					)}
					{error ? <ErrorBanner message={error} /> : null}
				</div>
				<DialogFooter>
					<Button onClick={onClose} type="button" variant="ghost">
						Cancel
					</Button>
					<Button
						loading={saving}
						onClick={() => {
							submit().catch(() => undefined);
						}}
						type="button"
					>
						Record metrics
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Rejecting is transition-gated server-side and stamps a reason onto the row,
 *  so the reason is collected before the call rather than left blank. */
export function RejectSubmissionDialog({
	onConfirm,
	onOpenChange,
	submission,
}: {
	onConfirm: (reason: string) => void;
	onOpenChange: (open: boolean) => void;
	submission: Submission | null;
}) {
	const [reason, setReason] = useState("");
	return (
		<Dialog onOpenChange={onOpenChange} open={submission !== null}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reject this submission?</DialogTitle>
					<DialogDescription>
						The reason is stored on the submission and any accrued (unpaid)
						payout for it is removed.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="ugc-reject-reason">Reason</Label>
					<Textarea
						id="ugc-reject-reason"
						onChange={(e) => setReason(e.target.value)}
						placeholder="Missing the required hashtag…"
						value={reason}
					/>
				</div>
				<DialogFooter>
					<Button
						onClick={() => {
							setReason("");
							onOpenChange(false);
						}}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						onClick={() => {
							onConfirm(reason.trim());
							setReason("");
						}}
						type="button"
						variant="destructive"
					>
						Reject submission
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
