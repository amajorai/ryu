import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ArenaAgentTally } from "./arena-model.ts";

interface Stat {
	/** Longer explanation, shown on hover and read with the number. */
	hint: string;
	id: string;
	label: string;
	/** Kept on narrow walls, where the rest of the strip folds away. */
	pinned: boolean;
	tone: string;
	value: string;
}

/*
 * Every number counts agents, the unit of the filter chips right below, and
 * uses the cards' own words: "working", "need you" (the chip), "failed".
 */
function statsOf(tally: ArenaAgentTally, tl: LiteralMessage): Stat[] {
	const list: Stat[] = [
		{
			hint: tl(
				"{working} of {total, plural, one {# agent} other {# agents}} running",
				{ total: tally.total, working: tally.working }
			),
			id: "working",
			label: "working",
			pinned: false,
			tone: "text-foreground",
			value: `${tally.working}/${tally.total}`,
		},
		{
			hint: tl(
				"{count, plural, one {# agent} other {# agents}} with a failed run or a reply waiting for you",
				{ count: tally.needsYou }
			),
			id: "needs-you",
			label: "need you",
			pinned: false,
			tone: "text-foreground",
			value: String(tally.needsYou),
		},
	];
	if (tally.failed > 0) {
		list.push({
			hint: tl(
				"{count, plural, one {# agent} other {# agents}} whose last run failed",
				{ count: tally.failed }
			),
			id: "failed",
			label: "failed",
			pinned: true,
			tone: "text-status-destructive",
			value: String(tally.failed),
		});
	}
	return list;
}

/**
 * The wall's live numbers as one inline strip beside the title. On narrow
 * walls only the failed count stays, since it is the one that cannot wait.
 */
export function ArenaStatStrip({
	className,
	tally,
}: {
	className?: string;
	tally: ArenaAgentTally;
}) {
	const tl = useLiteralMessages();
	return (
		<dl
			className={cn(
				"flex min-w-0 items-baseline gap-4 text-sm leading-5",
				className
			)}
		>
			{statsOf(tally, tl).map((stat) => (
				<div
					className={cn(
						"shrink-0 items-baseline gap-1",
						stat.pinned ? "flex" : "@2xl:flex hidden"
					)}
					key={stat.id}
					title={stat.hint}
				>
					<dt className="order-last text-muted-foreground">
						{stat.label}
						<span className="sr-only">. {stat.hint}</span>
					</dt>
					<dd className={cn("font-medium tabular-nums", stat.tone)}>
						{stat.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
