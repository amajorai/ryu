import {
	ChartLineData01Icon,
	PlugSocketIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import type {
	LeaderboardView as LeaderboardRow,
	RefreshCounts,
	SubmissionView as Submission,
	SubmissionRefreshReport,
} from "../ugc-wire-contracts.ts";
import {
	describeRefreshCounts,
	formatCents,
	formatCount,
	PAYOUT_STATUS_VARIANT,
	SUBMISSION_STATUS_VARIANT,
} from "./ugc-format.ts";
import {
	ConnectLink,
	ErrorBanner,
	PanelNotice,
	PostLink,
	StatusPill,
} from "./ugc-primitives.tsx";

/** What one refresh run did, split three ways.
 *
 *  `needs_connection` gets its own affordance rather than the destructive
 *  `ErrorBanner`: nothing is broken — the account behind that platform is simply
 *  not linked to this node's Composio entity yet — and the row carries Composio's
 *  own connect link when it offered one. Those rows wrote no snapshot and
 *  re-priced no payout, which is why the summary line counts them apart from the
 *  refreshed ones instead of reporting a flat total. */
export function RefreshReport({
	counts,
	describeRow,
	results,
}: {
	counts: RefreshCounts;
	describeRow: (submissionId: string) => string;
	results: SubmissionRefreshReport[];
}) {
	const tl = useLiteralMessages();
	const needsConnection = results.filter(
		(r) => r.status === "needs_connection"
	);
	const failed = results.filter((r) => r.status === "error");
	return (
		<div className="flex flex-col gap-2">
			<PanelNotice>{describeRefreshCounts(counts)}.</PanelNotice>
			{needsConnection.length > 0 ? (
				<div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs">
					<span className="flex items-center gap-1.5 font-medium">
						<HugeiconsIcon className="size-3.5" icon={PlugSocketIcon} />
						Connect these accounts to read their counters
					</span>
					{needsConnection.map((row) => (
						<span
							className="flex flex-wrap items-center gap-1.5"
							key={row.submission_id}
						>
							<span>{describeRow(row.submission_id)}</span>
							<span className="min-w-0 break-words text-muted-foreground">
								{row.message ??
									"This platform's account is not linked to Composio yet."}
							</span>
							<ConnectLink url={row.connect_url} />
						</span>
					))}
				</div>
			) : null}
			{failed.length > 0 ? (
				<ErrorBanner
					message={tl(
						"Could not refresh {count, plural, one {{countText} submission} other {{countText} submissions}}: {reasons}",
						{
							count: failed.length,
							countText: String(failed.length),
							reasons: failed
								.map(
									(row) =>
										`${describeRow(row.submission_id)} — ${
											row.message ?? "no reason given"
										}`
								)
								.join("; "),
						}
					)}
				/>
			) : null}
		</div>
	);
}

/** One post's accrued money and the state that money is in.
 *
 *  The null test is `typeof === "number"` rather than a truthiness or nullish
 *  check on purpose: a payout of exactly $0.00 is a real, reportable outcome (a
 *  campaign priced at zero, or an approved post with no views yet), and it must
 *  not be hidden behind the same "—" that means "nothing has accrued". */
function AccruedCell({
	cents,
	status,
}: {
	cents: number | null | undefined;
	status: Submission["payout_status"];
}) {
	if (cents === null || cents === undefined) {
		return <span className="text-muted-foreground">—</span>;
	}
	return (
		<span className="flex items-center justify-end gap-1.5">
			<span className="font-mono tabular-nums">{formatCents(cents)}</span>
			{status ? (
				<StatusPill
					label={status}
					variant={PAYOUT_STATUS_VARIANT.get(status) ?? "outline"}
				/>
			) : null}
		</span>
	);
}

export function SubmissionsTable({
	creatorName,
	hasMetricSource,
	onApprove,
	onRecordMetrics,
	onRefresh,
	onReject,
	platformLabel,
	submissions,
}: {
	creatorName: (id: string) => string;
	/** Whether the sidecar curates a Composio source for this platform. Without
	 *  one there is nothing to refresh, so the row does not offer it. */
	hasMetricSource: (platform: string) => boolean;
	onApprove: (submission: Submission) => void;
	onRecordMetrics: (submission: Submission) => void;
	onRefresh: (submission: Submission) => void;
	onReject: (submission: Submission) => void;
	platformLabel: (platform: string) => string;
	submissions: Submission[];
}) {
	if (submissions.length === 0) {
		return (
			<PanelNotice>
				No submissions match this filter. Creators&apos; posts appear here once
				recorded.
			</PanelNotice>
		);
	}
	return (
		<Table size="compact">
			<TableHeader>
				<TableRow>
					<TableHead size="compact">Creator</TableHead>
					<TableHead size="compact">Platform</TableHead>
					<TableHead size="compact">Post</TableHead>
					<TableHead size="compact">Status</TableHead>
					<TableHead className="text-right" size="compact">
						Views
					</TableHead>
					<TableHead className="text-right" size="compact">
						Accrued
					</TableHead>
					<TableHead size="compact">
						<span className="sr-only">Review actions</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{submissions.map((submission) => (
					<TableRow key={submission.id}>
						<TableCell spacing="compact">
							{creatorName(submission.creator_id)}
						</TableCell>
						<TableCell spacing="compact">
							{platformLabel(submission.platform)}
						</TableCell>
						<TableCell spacing="compact">
							<PostLink url={submission.post_url} />
						</TableCell>
						<TableCell spacing="compact">
							<StatusPill
								label={submission.status}
								variant={
									SUBMISSION_STATUS_VARIANT[submission.status] ?? "outline"
								}
							/>
						</TableCell>
						<TableCell
							className="text-right"
							presentation="numeric"
							spacing="compact"
						>
							{submission.latest ? formatCount(submission.latest.views) : "—"}
						</TableCell>
						<TableCell
							className="text-right"
							presentation="numeric"
							spacing="compact"
						>
							<AccruedCell
								cents={submission.accrued_cents}
								status={submission.payout_status}
							/>
						</TableCell>
						<TableCell className="text-right" spacing="compact">
							<SubmissionRowActions
								hasMetricSource={hasMetricSource}
								onApprove={onApprove}
								onRecordMetrics={onRecordMetrics}
								onRefresh={onRefresh}
								onReject={onReject}
								submission={submission}
							/>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** The per-row actions.
 *
 *  "Record metrics" is offered on every row that is not rejected, and it is NOT
 *  gated on `hasMetricSource` or on Composio being connected: it is the only way
 *  to get counters onto a platform the sidecar curates no source for, and it is
 *  the correction path when an automated read is wrong. A pending post gets it
 *  too — views are usually what the approve/reject decision turns on.
 *
 *  The Composio refresh stays where it was, on reviewed rows with a curated
 *  source, so the row never offers a read that has nothing to read from. */
function SubmissionRowActions({
	hasMetricSource,
	onApprove,
	onRecordMetrics,
	onRefresh,
	onReject,
	submission,
}: {
	hasMetricSource: (platform: string) => boolean;
	onApprove: (submission: Submission) => void;
	onRecordMetrics: (submission: Submission) => void;
	onRefresh: (submission: Submission) => void;
	onReject: (submission: Submission) => void;
	submission: Submission;
}) {
	const recordButton = (
		<Button
			onClick={() => onRecordMetrics(submission)}
			size="icon-xs"
			title="Record this post's metrics by hand"
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon icon={ChartLineData01Icon} />
			<span className="sr-only">Record metrics</span>
		</Button>
	);

	if (submission.status === "pending") {
		return (
			<span className="flex items-center justify-end gap-1">
				<Button
					onClick={() => onApprove(submission)}
					size="xs"
					type="button"
					variant="secondary"
				>
					Approve
				</Button>
				<Button
					onClick={() => onReject(submission)}
					size="xs"
					type="button"
					variant="ghost"
				>
					Reject
				</Button>
				{recordButton}
			</span>
		);
	}

	return (
		<span className="flex items-center justify-end gap-1">
			<span className="max-w-40 truncate text-muted-foreground">
				{submission.rejection_reason ?? ""}
			</span>
			{submission.status === "rejected" ? null : recordButton}
			{submission.status !== "rejected" &&
			hasMetricSource(submission.platform) ? (
				<Button
					onClick={() => onRefresh(submission)}
					size="icon-xs"
					title="Refresh this post's metrics"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon icon={RefreshIcon} />
					<span className="sr-only">Refresh metrics</span>
				</Button>
			) : null}
		</span>
	);
}

export function LeaderboardTable({
	creatorName,
	rows,
}: {
	creatorName: (id: string) => string;
	rows: LeaderboardRow[];
}) {
	if (rows.length === 0) {
		return (
			<PanelNotice>
				No ranked creators yet — the leaderboard fills in once submissions carry
				metrics.
			</PanelNotice>
		);
	}
	return (
		<Table size="compact">
			<TableHeader>
				<TableRow>
					<TableHead size="compact">Creator</TableHead>
					<TableHead className="text-right" size="compact">
						Views
					</TableHead>
					<TableHead className="text-right" size="compact">
						Approved
					</TableHead>
					<TableHead className="text-right" size="compact">
						Accrued
					</TableHead>
					<TableHead className="text-right" size="compact">
						Paid
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => (
					<TableRow key={row.creator_id}>
						{/* `||`, not `??`: the sidecar always sends this key and sends it
						    EMPTY when the creator row was deleted out from under the
						    submissions, so a nullish fallback would never fire and the
						    cell would render blank instead of the roster lookup. */}
						<TableCell spacing="compact">
							{row.display_name || creatorName(row.creator_id)}
						</TableCell>
						<TableCell
							className="text-right"
							presentation="numeric"
							spacing="compact"
						>
							{formatCount(row.views)}
						</TableCell>
						<TableCell
							className="text-right"
							presentation="numeric"
							spacing="compact"
						>
							{formatCount(row.approved_submissions)}
						</TableCell>
						<TableCell
							className="text-right"
							presentation="monospace-numeric"
							spacing="compact"
						>
							{formatCents(row.accrued_cents)}
						</TableCell>
						<TableCell
							className="text-right"
							presentation="monospace-numeric"
							spacing="compact"
						>
							{formatCents(row.paid_cents)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
