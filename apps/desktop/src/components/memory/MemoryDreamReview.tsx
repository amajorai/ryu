import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Card, CardContent, CardHeader } from "@ryu/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Label } from "@ryu/ui/components/label";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import {
	ArrowRight,
	Check,
	Clock3,
	RefreshCw,
	Sparkles,
	X,
} from "lucide-react";
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

function isUnsupported(error: unknown): boolean {
	return error instanceof ApiError && [404, 405, 501].includes(error.status);
}

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
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-muted-foreground text-xs">
				<span>{previous ? "Update" : "New memory"}</span>
				<ArrowRight className="size-3.5" />
				<span>{proposal.proposed.category.replaceAll("_", " ")}</span>
			</div>
			{previous ? (
				<div className="grid gap-2 md:grid-cols-2">
					<div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
						<div className="mb-1 font-medium text-destructive text-xs">
							Before
						</div>
						<p className="whitespace-pre-wrap text-sm leading-relaxed">
							{previous}
						</p>
					</div>
					<div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
						<div className="mb-1 font-medium text-emerald-700 text-xs dark:text-emerald-400">
							Proposed
						</div>
						<p className="whitespace-pre-wrap text-sm leading-relaxed">
							{next}
						</p>
					</div>
				</div>
			) : (
				<div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
					<p className="whitespace-pre-wrap text-sm leading-relaxed">{next}</p>
				</div>
			)}
			<div className="flex flex-wrap gap-1.5">
				<Badge variant="secondary">{proposal.proposed.scope}</Badge>
				<Badge variant="outline">
					Importance {proposal.proposed.importance}
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
		<Card className="border-border/70 shadow-none" data-testid="dream-proposal">
			<CardHeader className="gap-3 border-border/60 border-b pb-4">
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
			<CardContent className="flex flex-col gap-4 pt-4">
				<ProposalDiff proposal={proposal} />
				<div className="flex flex-wrap justify-end gap-2 border-border/60 border-t pt-3">
					<Button
						disabled={busy}
						onClick={() => onReject(proposal)}
						variant="ghost"
					>
						<X className="size-4" />
						Reject
					</Button>
					<Button disabled={busy} onClick={() => onAccept(proposal)}>
						<Check className="size-4" />
						Accept memory
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

export function MemoryDreamReview({ target }: { target: ApiTarget }) {
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
		<div className="mx-auto flex max-w-3xl flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<Sparkles className="size-5 text-primary" />
						<h1 className="font-medium text-lg">Dream review</h1>
					</div>
					<p className="mt-1 max-w-xl text-muted-foreground text-sm">
						Dream looks back at recent conversations and suggests durable
						memories. Nothing is saved until you accept it.
					</p>
				</div>
				<Button disabled={loading} loading={running} onClick={run}>
					{!running && <RefreshCw className="size-4" />}
					{running ? "Reviewing…" : "Run Dream now"}
				</Button>
			</div>

			<Card className="border-primary/20 bg-primary/5 shadow-none">
				<CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
					<div className="flex items-start gap-3">
						<div className="rounded-full bg-primary/10 p-2 text-primary">
							<Clock3 className="size-4" />
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

			{error && isUnsupported(error) ? (
				<Empty className="border border-dashed py-12">
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
				<div className="flex justify-center py-16">
					<Spinner />
				</div>
			) : error ? (
				<Empty className="border border-dashed py-12">
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
								`${review.proposals.length} proposal${review.proposals.length === 1 ? "" : "s"} waiting for your review.`}
						</span>
						<span>Last run {formatReviewDate(review.generatedAt)}</span>
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
				<Empty className="border border-dashed py-12">
					<EmptyHeader>
						<EmptyTitle>No new memories to review</EmptyTitle>
						<EmptyDescription>
							Dream will place suggestions here after it reviews your recent
							conversations.
						</EmptyDescription>
					</EmptyHeader>
					<Button disabled={running} onClick={run}>
						<Sparkles className="size-4" />
						Run Dream now
					</Button>
				</Empty>
			)}
		</div>
	);
}
