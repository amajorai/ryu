// apps/desktop/src/components/memory/MemoryDreamProposalCard.tsx
//
// One pending Dream proposal: what it would change (a new memory, a revision
// shown as before/proposed, or an archive of the memory as it is now), with
// Reject and Accept actions. The review screen owns the requests.

import {
	ArrowRight02Icon,
	Cancel01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Card, CardContent, CardHeader } from "@ryu/ui/components/card.tsx";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import {
	type Memory,
	memoryCategoryLabels,
	memoryScopeLabels,
} from "@/src/lib/api/memory.ts";
import type { MemoryProposal } from "@/src/lib/api/memory-dream.ts";
import { dreamReason, dreamSource } from "./memory-dream-copy.ts";

/**
 * Category and scope names in the active vocabulary. Core's ids ("user_fact",
 * "project") are normalized by the memory client, so each one has a label.
 */
function useMemoryLabels() {
	const tl = useLiteralMessages();
	const [friendly] = useFriendlyMode();
	return {
		category: (memory: Memory) =>
			tl(memoryCategoryLabels(friendly)[memory.category]),
		scope: (memory: Memory) => tl(memoryScopeLabels(friendly)[memory.scope]),
	};
}

function ProposalBadges({ memory }: { memory: Memory }) {
	const tl = useLiteralMessages();
	const labels = useMemoryLabels();
	return (
		<div className="flex flex-wrap gap-1.5">
			<Badge variant="secondary">{labels.scope(memory)}</Badge>
			<Badge variant="outline">
				{tl("Importance {importance}", {
					importance: String(memory.importance),
				})}
			</Badge>
			{memory.tags.map((tag) => (
				<Badge key={tag} variant="outline">
					#{tag}
				</Badge>
			))}
		</div>
	);
}

/**
 * An archive proposal: the memory Dream wants to retire, shown as it is now.
 * Accepting takes it out of recall; it is archived, not deleted.
 */
function ArchiveProposalDiff({ proposal }: { proposal: MemoryProposal }) {
	const current = proposal.current;
	const labels = useMemoryLabels();
	return (
		<div className="flex flex-col gap-2" data-testid="dream-archive">
			<div className="flex items-center gap-2 text-muted-foreground text-xs">
				<span>Retire memory</span>
				<DirectionalIcon className="size-3.5" icon={ArrowRight02Icon} />
				<span>{labels.category(current ?? proposal.proposed)}</span>
			</div>
			<div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
				<div className="mb-1 font-medium text-status-destructive text-xs">
					Current memory
				</div>
				{current ? (
					<p className="whitespace-pre-wrap text-sm leading-relaxed">
						{current.content}
					</p>
				) : (
					<p className="text-muted-foreground text-sm">
						This memory no longer exists.
					</p>
				)}
			</div>
			<p className="text-muted-foreground text-xs">
				Archiving stops Ryu from recalling this memory. It is not deleted.
			</p>
			{current ? <ProposalBadges memory={current} /> : null}
		</div>
	);
}

function ProposalDiff({ proposal }: { proposal: MemoryProposal }) {
	const previous = proposal.current?.content ?? null;
	const next = proposal.proposed.content;
	const labels = useMemoryLabels();
	if (proposal.operation === "archive") {
		return <ArchiveProposalDiff proposal={proposal} />;
	}
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-muted-foreground text-xs">
				<span>{previous ? "Update" : "New memory"}</span>
				<DirectionalIcon className="size-3.5" icon={ArrowRight02Icon} />
				<span>{labels.category(proposal.proposed)}</span>
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
			<ProposalBadges memory={proposal.proposed} />
		</div>
	);
}

export function ProposalCard({
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
	const tl = useLiteralMessages();
	const source = dreamSource(proposal.source, tl);
	const reason = dreamReason(proposal.reason, tl);
	const archive = proposal.operation === "archive";
	return (
		<Card borderTone="muted" data-testid="dream-proposal" elevation="flat">
			<CardHeader appearance="dream-proposal">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="font-medium text-sm">
								{archive ? "Retire this memory" : "Proposed memory"}
							</h2>
							{source ? <Badge variant="secondary">{source}</Badge> : null}
						</div>
						{reason ? (
							<p className="mt-1 text-muted-foreground text-xs">{reason}</p>
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
						{archive ? "Archive memory" : "Accept memory"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
