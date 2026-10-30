// apps/desktop/src/components/gateway/AgentEgressSection-plan-preview.tsx
//
// The inline confirmation for `AgentEgressSection.tsx`'s bulk tools action.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { ToolBridgePlan } from "@/src/lib/api/agent-egress.ts";

/**
 * The confirmation for the bulk action: the exact per-agent list, before
 * anything is written.
 *
 * Rendered INLINE rather than as a modal — this panel already lives inside the
 * Gateway dialog, and a dialog over a dialog is both a focus-trap problem and a
 * way to hide the list behind a scrim the user dismisses to get back to the row
 * they were reading.
 *
 * Every part of this is a refusal to let a one-click action be blind: the changes
 * are named, the skips are named WITH their reason (the flagship and bare
 * `acp:pi` are the ones most worth reading), and the fact that model traffic is
 * untouched is stated rather than implied by its absence.
 */
export function ToolsPlanPreview({
	busy,
	error,
	onApply,
	onCancel,
	plan,
}: {
	busy: boolean;
	error: string | null;
	onApply: () => void;
	onCancel: () => void;
	plan: ToolBridgePlan;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
			{plan.changes.length === 0 ? (
				<p className="text-muted-foreground text-xs leading-snug">
					Nothing to change. Every agent that can take Ryu's tools already has
					them.
				</p>
			) : (
				<>
					<p className="font-medium text-foreground text-xs">
						{tl(
							"Will turn Ryu's tools on for {count, plural, one {# agent} other {# agents}}:",
							{ count: plan.changes.length }
						)}
					</p>
					<ul className="flex flex-col gap-0.5">
						{plan.changes.map((change) => (
							<li
								className="text-muted-foreground text-xs leading-snug"
								key={change.agentId}
							>
								{tl("{name} — off → on", { name: change.name })}
							</li>
						))}
					</ul>
				</>
			)}
			{plan.skipped.length > 0 ? (
				<>
					<p className="font-medium text-foreground text-xs">
						{tl(
							"Leaves {count, plural, one {# agent} other {# agents}} alone:",
							{ count: plan.skipped.length }
						)}
					</p>
					<ul className="flex flex-col gap-0.5">
						{plan.skipped.map((skip) => (
							<li
								className="text-muted-foreground text-xs leading-snug"
								key={skip.agentId}
							>
								{skip.name} — {skip.reason}
							</li>
						))}
					</ul>
				</>
			) : null}
			{/* Stated, not implied. A "configure every agent" button that quietly
			    re-pointed a Claude Pro sign-in at the gateway and moved where that
			    spend is counted would be a serious misstep; saying what it does NOT
			    do is what makes the click safe to make. */}
			{plan.egressUntouched ? (
				<p className="text-muted-foreground text-xs leading-snug">
					Model traffic is not changed for any agent. Routing a subscription
					through the gateway moves where that credential goes and where the
					spend is counted, so it stays a per-agent choice you make on the row
					itself.
				</p>
			) : null}
			{error ? (
				<p className="text-status-destructive text-xs leading-snug">{error}</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					disabled={busy || plan.changes.length === 0}
					onClick={onApply}
					size="sm"
					variant="outline"
				>
					{busy ? "Applying…" : "Turn tools on"}
				</Button>
				<Button
					disabled={busy}
					onClick={onCancel}
					size="sm"
					variant="secondary"
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
