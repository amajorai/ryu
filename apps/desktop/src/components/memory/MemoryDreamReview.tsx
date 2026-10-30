import {
	ArrowRight02Icon,
	Cancel01Icon,
	Clock01Icon,
	Refresh01Icon,
	SparklesIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Card, CardContent, CardHeader } from "@ryu/ui/components/card.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
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
	runDreamReview,
	updateDreamSettings,
} from "@/src/lib/api/memory.ts";

function formatReviewDate(timestamp: number): string {
	if (!timestamp) {
		return "Not run yet";
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(timestamp);
}

function ProposalDiff({ proposal }: { proposal: MemoryProposal }) {
	const previous = proposal.current?.content ?? null;
	const next = proposal.proposed.content;
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-muted-foreground text-xs">
				<span>{previous ? "Update" : "New memory"}</span>
				<HugeiconsIcon className="size-3.5" icon={ArrowRight02Icon} />
				<span>{proposal.proposed.category.replaceAll("_", " ")}</span>
			</div>
			{previous ? (
				<div className="grid gap-2 md:grid-cols-2">
					<div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
						<div className="mb-1 font-medium text-status-destructive text-xs">
							Before
						</div>
						<p className="whitespace-pre-wrap text-sm leading-relaxed">
							{previous}
						</p>
					</div>
					<div className="rounded-lg border border-success/25 bg-success/5 p-3">
						<div className="mb-1 font-medium text-status-success text-xs">
							Proposed
						</div>
						<p className="whitespace-pre-wrap text-sm leading-relaxed">
							{next}
						</p>
					</div>
				</div>
			) : (
				<div className="rounded-lg border border-success/25 bg-success/5 p-3">
					<p className="whitespace-pre-wrap text-sm leading-relaxed">{next}</p>
				</div>
			)}
			<div className="flex flex-wrap gap-1.5">
				<Badge variant="secondary">{proposal.proposed.scope}</Badge>
				<Badge variant="outline">
					{tl("Importance {importance}", {
						importance: String(proposal.proposed.importance),
					})}
				</Badge>
				{proposal.proposed.tags.map((tag) => (
					<Badge key={tag} variant="outline">
						#{tag}
					</Badge>
				))}
			</div>
		</div>
	);
}

function ProposalCard({
	busy,
	onAccept,
	onReject,
	proposal,
}: {
	busy: boolean;
	onAccept: (proposal: MemoryProposal) => void;
	onReject: (proposal: MemoryProposal) => void;
	proposal: MemoryProposal;
}) {
	return (
		<Card borderTone="muted" data-testid="dream-proposal" elevation="flat">
			<CardHeader appearance="dream-proposal">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="font-medium text-sm">Proposed memory</h2>
							{proposal.source ? (
								<Badge variant="secondary">{proposal.source}</Badge>
							) : null}
						</div>
						{proposal.reason ? (
							<p className="mt-1 text-muted-foreground text-xs">
								{proposal.reason}
							</p>
						) : null}
					</div>
					<Badge variant="outline">Needs review</Badge>
				</div>
			</CardHeader>
			<CardContent layout="spaced-stack" topSpacing="comfortable">
				<ProposalDiff proposal={proposal} />
				<div className="flex flex-wrap justify-end gap-2 border-border border-t pt-3">
					<Button
						disabled={busy}
						onClick={() => onReject(proposal)}
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						Reject
					</Button>
					<Button disabled={busy} onClick={() => onAccept(proposal)}>
						<HugeiconsIcon className="size-4" icon={Tick02Icon} />
						Accept memory
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

export function MemoryDreamReview({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
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

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		const [reviewResult, settingsResult] = await Promise.allSettled([
			getDreamReview(target),
			getDreamSettings(target),
		]);
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
			setReview(
				await runDreamReview(
					target,
					settings.automatic ? "automatic" : "manual"
				)
			);
			toast.success("Dream review ready", {
				description: "Review the proposed memories below before saving them.",
			});
		} catch (nextError) {
			setError(nextError);
			toast.error("Dream review couldn't run", {
				description: "Check that this node supports Dream and try again.",
			});
		} finally {
			setRunning(false);
		}
	};

	const toggleAutomatic = async (automatic: boolean) => {
		const previous = settings;
		setSettings((current) => ({ ...current, automatic }));
		try {
			setSettings(await updateDreamSettings(target, { automatic }));
		} catch {
			setSettings(previous);
			setSettingsError(true);
			toast.error("Automatic Dream review couldn't be saved");
		}
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
						}
					: current
			);
			toast.success("Memory accepted");
		} catch {
			toast.error("Couldn't accept this memory", {
				description: "The proposal is still waiting for review.",
			});
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
		} catch {
			toast.error("Couldn't reject this proposal");
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

			<Card appearance="dream-highlight" elevation="flat">
				<CardContent layout="summary-actions" topSpacing="generous">
					<div className="flex items-start gap-3">
						<div className="rounded-full bg-primary/10 p-2 text-primary">
							<HugeiconsIcon className="size-4" icon={Clock01Icon} />
						</div>
						<div>
							<Label htmlFor="dream-automatic">Automatic review</Label>
							<p className="mt-1 text-muted-foreground text-xs">
								Let Dream prepare proposals on its own. You still decide what
								enters Memory.
							</p>
						</div>
					</div>
					<Switch
						checked={settings.automatic}
						disabled={settingsError}
						id="dream-automatic"
						onCheckedChange={toggleAutomatic}
					/>
				</CardContent>
			</Card>

			{error &&
			error instanceof ApiError &&
			[404, 405, 501].includes(error.status) ? (
				<Empty appearance="bordered">
					<EmptyHeader>
						<EmptyTitle>Dream is not available on this node yet</EmptyTitle>
						<EmptyDescription>
							Update Core to enable review proposals. The desktop is ready for
							the Dream API at <code>/api/memory/dream/review</code>.
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
						<span>
							{review.summary ??
								tl(
									"{count, plural, one {# proposal} other {# proposals}} waiting for your review.",
									{ count: review.proposals.length }
								)}
						</span>
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
		</div>
	);
}
