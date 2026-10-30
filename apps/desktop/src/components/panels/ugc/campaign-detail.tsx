import {
	PlusSignIcon,
	RefreshIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useState } from "react";
import {
	type CampaignView as Campaign,
	type CampaignSummaryView as CampaignSummary,
	type CreatorView as Creator,
	campaignSummaryViewSchema,
	type LeaderboardView as LeaderboardRow,
	leaderboardViewSchema,
	normalizedSubmissionRefreshSchema,
	type PlatformView as PlatformSource,
	type RefreshCounts,
	readUgcList,
	refreshCountsSchema,
	type SubmissionView as Submission,
	type SubmissionRefreshReport,
	submissionViewSchema,
	ugcDocumentSchema,
} from "../ugc-wire-contracts.ts";
import {
	LeaderboardTable,
	RefreshReport,
	SubmissionsTable,
} from "./campaign-tables.tsx";
import {
	RecordMetricsDialog,
	RejectSubmissionDialog,
} from "./metrics-reject-dialogs.tsx";
import { NewSubmissionDialog } from "./new-creator-submission-dialogs.tsx";
import {
	CAMPAIGN_STATUS_VARIANT,
	describeError,
	formatCents,
	formatCount,
	formatDate,
	formatPayoutRule,
	LEADERBOARD_LIMIT,
	tallyRefresh,
	useUgcCall,
} from "./ugc-format.ts";
import {
	ErrorBanner,
	LoadingRow,
	SpendBar,
	StatTile,
	StatusPill,
} from "./ugc-primitives.tsx";

const SUBMISSION_STATUS_FILTERS: Array<{ label: string; value: string }> = [
	{ label: "All submissions", value: "" },
	{ label: "Pending", value: "pending" },
	{ label: "Approved", value: "approved" },
	{ label: "Rejected", value: "rejected" },
	{ label: "Paid", value: "paid" },
];

interface CampaignDetailData {
	leaderboard: LeaderboardRow[];
	submissions: Submission[];
	summary: CampaignSummary | null;
}

export function CampaignDetail({
	campaign,
	composioConfigured,
	creatorName,
	creators,
	invalidate,
	onOpenGatewayKeys,
	platformLabel,
	platforms,
	revision,
}: {
	campaign: Campaign;
	composioConfigured: boolean | null;
	creatorName: (id: string) => string;
	creators: Creator[];
	invalidate: () => void;
	onOpenGatewayKeys: () => void;
	platformLabel: (platform: string) => string;
	platforms: PlatformSource[];
	revision: number;
}) {
	const tl = useLiteralMessages();
	const call = useUgcCall();
	const [data, setData] = useState<CampaignDetailData>({
		leaderboard: [],
		submissions: [],
		summary: null,
	});
	const [statusFilter, setStatusFilter] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	// Tagged with the campaign it was run against, so switching campaigns cannot
	// leave another campaign's refresh report on screen. One state for both the
	// campaign-wide run and a single row's, because a single row can answer
	// `needs_connection` too and that answer must not vanish into a reload.
	const [refreshReport, setRefreshReport] = useState<{
		campaignId: string;
		counts: RefreshCounts;
		results: SubmissionRefreshReport[];
	} | null>(null);
	const [adding, setAdding] = useState(false);
	const [rejecting, setRejecting] = useState<Submission | null>(null);
	/** The submission whose counters are being entered by hand, or null. Holding
	 *  the row (not just its id) is what lets the dialog prefill from the latest
	 *  snapshot. */
	const [recordingMetrics, setRecordingMetrics] = useState<Submission | null>(
		null
	);
	const [actionError, setActionError] = useState<string | null>(null);

	const campaignId = campaign.id;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		const query = statusFilter ? `?status=${statusFilter}` : "";
		Promise.all([
			call(`/campaigns/${encodeURIComponent(campaignId)}/summary`).then(
				campaignSummaryViewSchema.parse
			),
			call(`/campaigns/${encodeURIComponent(campaignId)}/submissions${query}`),
			call(
				`/campaigns/${encodeURIComponent(campaignId)}/leaderboard?limit=${LEADERBOARD_LIMIT}`
			),
		])
			.then(([summary, submissions, leaderboard]) => {
				if (cancelled) {
					return;
				}
				setData({
					leaderboard: readUgcList(
						leaderboard,
						"leaderboard",
						leaderboardViewSchema
					),
					submissions: readUgcList(
						submissions,
						"submissions",
						submissionViewSchema
					),
					summary,
				});
				setError(null);
			})
			.catch((err) => {
				if (!cancelled) {
					setError(describeError(err));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [call, campaignId, statusFilter, revision]);

	const review = useCallback(
		async (
			submission: Submission,
			decision: "approve" | "reject",
			reason?: string
		) => {
			setActionError(null);
			try {
				await call(`/submissions/${encodeURIComponent(submission.id)}/review`, {
					body: JSON.stringify({ decision, reason }),
					method: "POST",
				});
				invalidate();
			} catch (err) {
				setActionError(describeError(err));
			}
		},
		[call, invalidate]
	);

	const refreshMetrics = useCallback(async () => {
		setRefreshing(true);
		setActionError(null);
		// Cleared before the run, not after it: a report left on screen while a new
		// run is in flight — or beside the error of a run that never produced one —
		// would describe results this click did not get.
		setRefreshReport(null);
		try {
			const resp = await call(
				`/campaigns/${encodeURIComponent(campaignId)}/refresh`,
				{
					method: "POST",
				}
			);
			// A 200 here does NOT mean every submission was read: the route is
			// best-effort per submission and reports each one's outcome as one of
			// three, so the report is rendered rather than counted as a success.
			const results = readUgcList(
				resp,
				"results",
				normalizedSubmissionRefreshSchema
			);
			const document = ugcDocumentSchema.parse(resp);
			const counts = refreshCountsSchema.safeParse(document.counts);
			setRefreshReport({
				campaignId,
				counts: counts.success ? counts.data : tallyRefresh(results),
				results,
			});
			invalidate();
		} catch (err) {
			setActionError(describeError(err));
		} finally {
			setRefreshing(false);
		}
	}, [call, campaignId, invalidate]);

	/** The escape hatch for one post: re-read just this submission's counters.
	 *  A platform with no curated source 400s here with that exact explanation. */
	const refreshOne = useCallback(
		async (submission: Submission) => {
			setActionError(null);
			// Same reason as the campaign-wide run: the last report must not survive
			// a click that failed to produce one.
			setRefreshReport(null);
			try {
				const resp = await call(
					`/submissions/${encodeURIComponent(submission.id)}/refresh`,
					{
						method: "POST",
					}
				);
				// A 200 on this route is not necessarily a reading either: an unlinked
				// account comes back `needs_connection` having written nothing, so it
				// goes through the same report as a campaign-wide run instead of
				// looking like a refresh that worked.
				const row = normalizedSubmissionRefreshSchema.parse(resp);
				setRefreshReport({
					campaignId,
					counts: tallyRefresh([row]),
					results: [row],
				});
				invalidate();
			} catch (err) {
				setActionError(describeError(err));
			}
		},
		[call, campaignId, invalidate]
	);

	const hasMetricSource = useCallback(
		(platform: string) => platforms.some((p) => p.platform === platform),
		[platforms]
	);

	/** Name a reported row in the operator's terms. The id itself when the row is
	 *  not on screen — a campaign refresh covers every approved submission, not
	 *  only the ones the current status filter shows. */
	const describeRow = useCallback(
		(submissionId: string) => {
			const row = data.submissions.find((s) => s.id === submissionId);
			return row
				? `${creatorName(row.creator_id)} · ${platformLabel(row.platform)}`
				: submissionId.slice(0, 8);
		},
		[creatorName, data.submissions, platformLabel]
	);

	const summary = data.summary;
	const report =
		refreshReport?.campaignId === campaignId ? refreshReport : null;
	const composioMissing = composioConfigured === false;

	return (
		<section className="flex flex-col gap-3 p-3">
			<header className="flex flex-wrap items-center gap-2">
				<h2 className="min-w-0 font-semibold text-sm">
					{campaign.brand || "Untitled campaign"}
				</h2>
				<StatusPill
					label={campaign.status}
					variant={CAMPAIGN_STATUS_VARIANT[campaign.status] ?? "outline"}
				/>
				<span className="text-muted-foreground text-xs">
					{formatDate(campaign.starts_at)} → {formatDate(campaign.ends_at)}
				</span>
				<span className="text-muted-foreground text-xs">
					· {formatPayoutRule(campaign.payout)}
				</span>
				<span className="flex-1" />
				<Button
					disabled={refreshing}
					onClick={() => {
						refreshMetrics().catch(() => undefined);
					}}
					size="xs"
					title={
						composioMissing
							? "No managed Composio provider is configured — open Gateway → Keys, or record metrics by hand"
							: "Refresh metrics for every approved submission"
					}
					type="button"
					variant="ghost"
				>
					{refreshing ? (
						<Spinner className="size-3.5" />
					) : (
						<HugeiconsIcon icon={RefreshIcon} />
					)}
					Refresh metrics
				</Button>
				<Button
					onClick={() => setAdding(true)}
					size="xs"
					type="button"
					variant="secondary"
				>
					<HugeiconsIcon icon={PlusSignIcon} />
					Add submission
				</Button>
			</header>

			{campaign.brief ? (
				<p className="text-muted-foreground text-xs">{campaign.brief}</p>
			) : null}

			{error ? <ErrorBanner message={error} /> : null}
			{actionError ? <ErrorBanner message={actionError} /> : null}
			{report ? (
				<RefreshReport
					counts={report.counts}
					describeRow={describeRow}
					results={report.results}
				/>
			) : null}

			{loading && !summary ? <LoadingRow /> : null}
			{summary ? (
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					<StatTile
						hint={
							campaign.budget_cents > 0
								? `of ${formatCents(summary.budget_cents)}`
								: "no budget cap"
						}
						label="Accrued"
						value={formatCents(summary.accrued_cents)}
					/>
					<StatTile
						hint={tl("{amount} approved", {
							amount: formatCents(summary.approved_cents),
						})}
						label="Paid"
						value={formatCents(summary.paid_cents)}
					/>
					<StatTile
						hint={tl("{count} likes", {
							count: formatCount(summary.total_likes),
						})}
						label="Views"
						value={formatCount(summary.total_views)}
					/>
					<StatTile
						hint={tl("{creators} creators", {
							creators: String(summary.creators),
						})}
						label="Submissions"
						value={`${summary.submissions.pending} pending · ${summary.submissions.approved} approved`}
					/>
				</div>
			) : null}
			{summary ? (
				<SpendBar
					budgetCents={summary.budget_cents}
					spentCents={summary.accrued_cents}
				/>
			) : null}

			<div className="flex items-center gap-2">
				<h3 className="font-medium text-xs">Submissions</h3>
				<NativeSelect
					aria-label="Filter submissions by status"
					onChange={(e) => setStatusFilter(e.target.value)}
					size="sm"
					value={statusFilter}
				>
					{SUBMISSION_STATUS_FILTERS.map((opt) => (
						<NativeSelectOption key={opt.value} value={opt.value}>
							{opt.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{/* The sidecar reports managed provider availability; it does not own a
			    Composio key. Per-platform account connections remain a separate fact,
			    reported per submission as "needs a connection". */}
			{composioMissing ? (
				<div className="flex flex-wrap items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
					<span className="min-w-0">
						No managed Composio provider is configured on this node. Configure
						it in Gateway → Keys, or record metrics by hand meanwhile.
					</span>
					<Button
						onClick={onOpenGatewayKeys}
						size="xs"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon icon={Settings01Icon} />
						Gateway keys
					</Button>
				</div>
			) : null}
			<SubmissionsTable
				creatorName={creatorName}
				hasMetricSource={hasMetricSource}
				onApprove={(s) => {
					review(s, "approve").catch(() => undefined);
				}}
				onRecordMetrics={setRecordingMetrics}
				onRefresh={(s) => {
					refreshOne(s).catch(() => undefined);
				}}
				onReject={setRejecting}
				platformLabel={platformLabel}
				submissions={data.submissions}
			/>

			<h3 className="font-medium text-xs">Creator leaderboard</h3>
			<LeaderboardTable creatorName={creatorName} rows={data.leaderboard} />

			<NewSubmissionDialog
				campaign={campaign}
				creators={creators}
				onCreated={invalidate}
				onOpenChange={setAdding}
				open={adding}
				platforms={platforms}
			/>
			{/* Mounted only while a row is selected and keyed by that row's id, so
			    the five prefilled counters can never be a previously-opened
			    submission's — a stale number here would be written back as this
			    post's truth. */}
			{recordingMetrics ? (
				<RecordMetricsDialog
					key={recordingMetrics.id}
					onClose={() => setRecordingMetrics(null)}
					onRecorded={() => {
						setRecordingMetrics(null);
						invalidate();
					}}
					submission={recordingMetrics}
				/>
			) : null}
			<RejectSubmissionDialog
				onConfirm={(reason) => {
					const target = rejecting;
					setRejecting(null);
					if (target) {
						review(target, "reject", reason).catch(() => undefined);
					}
				}}
				onOpenChange={(next) => {
					if (!next) {
						setRejecting(null);
					}
				}}
				submission={rejecting}
			/>
		</section>
	);
}
