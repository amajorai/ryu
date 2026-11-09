// apps/desktop/src/components/memory/MemoryDreamRecent.tsx
//
// Dream's "Recently accepted" list: proposals accepted in the last week, each
// with an Undo that rolls the change back (the memory Dream wrote is retracted
// and the one it replaced or archived is active again).

import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import type { MemoryProposal } from "@/src/lib/api/memory-dream.ts";

/** What accepting the proposal did, as a short label. */
function appliedLabel(proposal: MemoryProposal): string {
	if (proposal.operation === "archive") {
		return "Archived";
	}
	return proposal.operation === "revise" ? "Updated" : "Saved";
}

/** The memory the change is about: the archived one, or the one written. */
function appliedContent(proposal: MemoryProposal): string {
	if (proposal.operation === "archive") {
		return proposal.current?.content ?? proposal.proposed.content;
	}
	return proposal.proposed.content;
}

export function MemoryDreamRecent({
	busyProposal,
	onUndo,
	recent,
}: {
	busyProposal: string | null;
	onUndo: (proposal: MemoryProposal) => void;
	recent: MemoryProposal[];
}) {
	if (recent.length === 0) {
		return null;
	}
	return (
		<section
			aria-labelledby="dream-recent-title"
			className="flex flex-col gap-2"
			data-testid="dream-recent"
		>
			<h2 className="font-medium text-sm" id="dream-recent-title">
				Recently accepted
			</h2>
			<ul className="flex flex-col rounded-lg border border-border">
				{recent.map((proposal) => (
					<li
						className="flex items-start gap-3 border-border border-b px-3 py-2.5 last:border-b-0"
						data-testid="dream-recent-item"
						key={proposal.id}
					>
						<div className="min-w-0 flex-1">
							<p className="line-clamp-2 whitespace-pre-wrap text-sm">
								{appliedContent(proposal)}
							</p>
							<Badge className="mt-1" variant="outline">
								{appliedLabel(proposal)}
							</Badge>
						</div>
						<Button
							disabled={busyProposal !== null}
							onClick={() => onUndo(proposal)}
							size="sm"
							variant="ghost"
						>
							<DirectionalIcon
								className="size-4"
								icon={ArrowTurnBackwardIcon}
							/>
							Undo
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
