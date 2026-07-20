import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useMemo } from "react";
import {
	CheckIcon,
	IconArrowRight,
} from "@/components/agent-elements/icons.tsx";
import {
	BouncyAccordion,
	type BouncyAccordionItem,
} from "@/src/components/ui/bouncy-accordion.tsx";
import type { ResolvedQuest } from "@/src/hooks/useGettingStarted.ts";

// Borderless status circle: each quest shows its topic icon inside a filled
// (never outlined) disc — muted while pending, tinted while current, and a
// green check once done.
function StatusIcon({ quest }: { quest: ResolvedQuest }) {
	if (quest.status === "completed") {
		return (
			<div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground shadow-sm">
				<CheckIcon className="size-2.5 drop-shadow-[0_1px_1px_rgba(0,0,0,0.18)]" />
			</div>
		);
	}
	const isCurrent = quest.status === "in_progress";
	return (
		<div
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-full",
				isCurrent
					? "bg-primary/15 text-primary"
					: "bg-muted text-muted-foreground"
			)}
		>
			<HugeiconsIcon className="size-3" icon={quest.icon} />
		</div>
	);
}

/**
 * Interactive onboarding checklist rendered as a bouncy accordion (ported from
 * beui.dev/components/motion/bouncy-accordion). Each quest is a row that
 * springs open to reveal its blurb and a CTA; following the CTA opens its page
 * and stamps it done. Completed quests collapse to an inert, struck-through row.
 */
export const GettingStartedChecklist = memo(function GettingStartedChecklist({
	quests,
	onRun,
}: {
	quests: ResolvedQuest[];
	onRun: (id: string) => void;
}) {
	const items = useMemo<BouncyAccordionItem[]>(
		() =>
			quests.map((quest) => {
				const done = quest.status === "completed";
				return {
					id: quest.id,
					disabled: done,
					icon: <StatusIcon quest={quest} />,
					title: (
						<span
							className={cn(
								done && "text-foreground/50 line-through",
								quest.status === "in_progress" && "text-foreground",
								quest.status === "pending" && "text-foreground/80"
							)}
						>
							{quest.content}
						</span>
					),
					description: done ? undefined : (
						<div className="flex flex-col items-start gap-3">
							<p>{quest.description}</p>
							<button
								className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 font-medium text-[13px] text-background outline-none transition-opacity hover:opacity-90 focus-visible:opacity-90"
								onClick={() => onRun(quest.id)}
								type="button"
							>
								{quest.cta}
								<IconArrowRight className="size-3.5" />
							</button>
						</div>
					),
				};
			}),
		[quests, onRun]
	);

	// Default-open the current step so the next action is one click away.
	const nextId = useMemo(
		() => quests.find((quest) => quest.status === "in_progress")?.id ?? null,
		[quests]
	);

	return (
		<BouncyAccordion
			classNames={{ item: "border border-border/60" }}
			defaultValue={nextId}
			items={items}
		/>
	);
});
