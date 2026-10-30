import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { ArenaCardView } from "./arena-model.ts";

interface CountToken {
	label: string;
	status: ThreadStatus;
	/** Number and label tone; only a failed count leaves the neutral scale. */
	tone: { label: string; value: string };
}

const NEUTRAL_TONE = {
	label: "text-muted-foreground",
	value: "text-foreground",
};

const COUNT_TOKENS: readonly CountToken[] = [
	{
		label: "failed",
		status: "attention",
		tone: {
			label: "text-status-destructive",
			value: "text-status-destructive",
		},
	},
	{ label: "your turn", status: "your-turn", tone: NEUTRAL_TONE },
	{ label: "waiting", status: "waiting", tone: NEUTRAL_TONE },
];

/** ICU select keys cannot hold a hyphen; each status maps to a plain key. */
const COUNT_ARIA_KEY: Record<ThreadStatus, string> = {
	attention: "attention",
	quiet: "quiet",
	waiting: "waiting",
	working: "working",
	"your-turn": "yourTurn",
};

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function Counts({
	card,
	compact,
	onOpen,
	tabIndex,
}: {
	card: ArenaCardView;
	compact: boolean;
	onOpen: (threadId: string) => void;
	tabIndex: number;
}) {
	const tl = useLiteralMessages();
	const shown = COUNT_TOKENS.filter((token) => card.counts[token.status] > 0);
	if (shown.length === 0) {
		return (
			<p
				className={cn(
					"truncate text-[13px] text-muted-foreground leading-6",
					compact && "hidden"
				)}
			>
				{card.threadCount === 0
					? "Ready for a first message"
					: tl(
							"{count, plural, one {{countText} thread} other {{countText} threads}}, nothing waiting on you",
							{
								count: card.threadCount,
								countText: String(card.threadCount),
							}
						)}
			</p>
		);
	}
	return (
		<ul
			aria-label={tl("{name}'s threads", { name: card.name })}
			className="-ms-1.5 flex min-w-0 flex-wrap items-center"
		>
			{shown.map((token, index) => {
				const count = card.counts[token.status];
				const shared = card.shared[token.status] ?? 0;
				const threadId = card.latestByStatus[token.status];
				const ariaValues = {
					count: String(count),
					name: card.name,
					shared: String(shared),
					status: COUNT_ARIA_KEY[token.status],
				};
				return (
					<li className="flex shrink-0 items-center" key={token.status}>
						{index > 0 ? (
							<span
								aria-hidden="true"
								className="text-[13px] text-muted-foreground"
							>
								·
							</span>
						) : null}
						<button
							aria-label={
								shared > 0
									? tl(
											"Open {name}'s latest {status, select, attention {failed run} quiet {unstarted thread} waiting {thread waiting on the agent} working {running thread} other {reply waiting for you}} ({count} total, {shared} shared with other agents and counted on their cards too)",
											ariaValues
										)
									: tl(
											"Open {name}'s latest {status, select, attention {failed run} quiet {unstarted thread} waiting {thread waiting on the agent} working {running thread} other {reply waiting for you}} ({count} total)",
											ariaValues
										)
							}
							className={cn(
								"relative z-10 inline-flex h-6 items-baseline gap-1 rounded-md px-1.5 text-[13px] leading-6 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
							)}
							disabled={!threadId}
							onClick={() => (threadId ? onOpen(threadId) : undefined)}
							tabIndex={tabIndex}
							title={
								shared > 0
									? tl(
											"Includes {shared, plural, one {{sharedText} shared thread} other {{sharedText} shared threads}}, also counted on teammates' cards",
											{ shared, sharedText: String(shared) }
										)
									: undefined
							}
							type="button"
						>
							<span
								className={cn("font-medium tabular-nums", token.tone.value)}
							>
								{count}
							</span>
							<span className={token.tone.label}>{token.label}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
