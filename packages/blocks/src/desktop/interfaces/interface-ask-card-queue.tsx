import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	askBubble,
	blockerAriaLabel,
	blockerKindWord,
	type ClockOptions,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	isSuggestion,
} from "@ryuhq/protocol/interfaces";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { type BlockerEntry, blockerEntries } from "./game3d-acts.ts";
import {
	askOwners,
	isolateKeys,
	ownerName,
	plural,
} from "./interface-ask-card-core.ts";

// ---------------------------------------------------------------------------
// Ask queue
// ---------------------------------------------------------------------------

/** "3 asks need you", "1 ask needs you". */
export function needYouHeading(count: number, tl: LiteralMessage): string {
	return count === 1
		? "1 ask needs you"
		: tl("{count} asks need you", { count: String(count) });
}

/** The queue's four groups, in order (empty groups are left out). */
export interface AskQueueGroups {
	answers: InterfaceAsk[];
	blocking: InterfaceAsk[];
	stopped: BlockerEntry[];
	suggestions: InterfaceAsk[];
}

export function askQueueGroups(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	unowned: readonly InterfaceAsk[]
): AskQueueGroups {
	const asks = [...(snapshot.asks ?? [])];
	for (const ask of unowned) {
		if (!asks.some((item) => item.id === ask.id)) {
			asks.push(ask);
		}
	}
	const since = (ask: InterfaceAsk) =>
		ask.since ? Date.parse(ask.since) : Number.NEGATIVE_INFINITY;
	return {
		answers: asks
			.filter((ask) => ask.kind === "reply")
			.sort((a, b) => since(b) - since(a) || (a.id < b.id ? -1 : 1)),
		blocking: asks.filter((ask) => ask.blocking).sort(compareAsks),
		stopped: blockerEntries(snapshot, acts),
		suggestions: asks.filter((ask) => isSuggestion(ask)).sort(compareAsks),
	};
}

/** Items shown in a capped group before "Show N more". */
export const QUEUE_GROUP_CAP = 5;

function QueueGroup({
	children,
	count,
	heading,
	capped,
}: {
	capped: boolean;
	children: (limit: number) => ReactNode;
	count: number;
	heading: string;
}) {
	const tl = useLiteralMessages();
	const [expanded, setExpanded] = useState(false);
	const headingId = useId();
	const listRef = useRef<HTMLOListElement>(null);
	const revealFrom = useRef<number | null>(null);
	useEffect(() => {
		if (count <= QUEUE_GROUP_CAP) {
			setExpanded(false);
		}
	}, [count]);
	// "Show N more" leaves the page when pressed: hand focus to the first
	// item it revealed, so focus never falls to the body.
	useEffect(() => {
		if (!expanded || revealFrom.current === null) {
			return;
		}
		const items = listRef.current?.querySelectorAll<HTMLElement>("button");
		items?.[revealFrom.current]?.focus();
		revealFrom.current = null;
	}, [expanded]);
	if (count === 0) {
		return null;
	}
	const limit = capped && !expanded ? QUEUE_GROUP_CAP : count;
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-1">
			<h3
				className="font-semibold text-(--gk-ink-muted) text-[12px] uppercase tracking-wide"
				id={headingId}
			>
				{heading}
			</h3>
			<ol className="flex flex-wrap gap-1.5" ref={listRef}>
				{children(limit)}
			</ol>
			{count > limit ? (
				<button
					className={cn(
						GAME_FOCUS,
						"self-start rounded-full px-2 py-1 font-semibold text-[12px] underline"
					)}
					onClick={() => {
						revealFrom.current = limit;
						setExpanded(true);
					}}
					type="button"
				>
					{tl("Show {count} more", { count: String(count - limit) })}
				</button>
			) : null}
		</section>
	);
}

const QUEUE_BUTTON = cn(
	GAME_PLATE,
	GAME_FOCUS,
	"min-h-7 max-w-64 truncate rounded-full px-2.5 text-start font-semibold text-[12px] leading-6"
);

/**
 * Everything waiting on the user, as buttons, in four groups: blocking
 * asks (all of them), stopped runs, suggestions and unread answers (the
 * last three capped at 5 with "Show N more"). Each ask button is named by
 * `askAriaLabel`, each stopped run by `blockerAriaLabel`, and opens its
 * card. `reveal` (in the stage) is visually hidden until a button inside
 * has focus, then shows as a plate strip; `sheet` is always visible.
 */
export function AskQueueList({
	acts,
	clock,
	fallbackFocus,
	mode = "reveal",
	nowMs,
	onAsk,
	onBlocker,
	snapshot,
	unowned,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/**
	 * The game's focusable heading: where focus goes when the item that had
	 * it leaves the list (answered elsewhere) and nothing is left to take it.
	 */
	fallbackFocus?: RefObject<HTMLElement | null>;
	mode?: "reveal" | "sheet";
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
	unowned: readonly InterfaceAsk[];
}) {
	const tl = useLiteralMessages();
	const privacy = snapshot.privacy ?? "full";
	const groups = useMemo(
		() => askQueueGroups(snapshot, acts, unowned),
		[acts, snapshot, unowned]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const navRef = useRef<HTMLElement>(null);
	const focusInside = useRef(false);
	// The focused item left the list: keep focus in the queue (its first
	// item), or on the game's heading when the queue emptied.
	useEffect(() => {
		if (!focusInside.current || typeof document === "undefined") {
			return;
		}
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) {
			return;
		}
		focusInside.current = false;
		const first = navRef.current?.querySelector<HTMLElement>(
			"[data-ask-queue-item]"
		);
		(first ?? fallbackFocus?.current)?.focus();
	});
	const askButton = (ask: InterfaceAsk) => {
		const owner = ownerName(ask, acts, owners);
		return (
			<li key={ask.id}>
				<button
					aria-label={askAriaLabel(ask, owner, nowMs, privacy)}
					className={QUEUE_BUTTON}
					data-ask-id={ask.id}
					data-ask-queue-item=""
					onClick={(event) => onAsk(ask.id, event.currentTarget)}
					type="button"
				>
					{`${owner ?? "Inbox"}: ${askBubble(ask, privacy)}`}
				</button>
			</li>
		);
	};
	const total =
		groups.blocking.length +
		groups.stopped.length +
		groups.suggestions.length +
		groups.answers.length;
	if (total === 0) {
		return null;
	}
	return (
		<nav
			aria-label="Ask queue"
			className={cn(
				"flex flex-col gap-2",
				mode === "reveal" &&
					cn(
						GAME_PLATE,
						"pointer-events-auto absolute inset-x-2 top-2 z-40 max-h-[60%] overflow-y-auto p-2.5 [&:not(:focus-within)]:sr-only"
					)
			)}
			data-ask-queue={mode}
			onBlur={(event) => {
				focusInside.current = navRef.current?.contains(
					event.relatedTarget as Node | null
				)
					? true
					: event.relatedTarget === null;
			}}
			onFocus={() => {
				focusInside.current = true;
			}}
			onKeyDown={(event) => {
				// In the Queue sheet or popover, Escape goes on to the container,
				// which closes it and isolates the key from the game.
				if (mode === "sheet" && event.key === "Escape") {
					return;
				}
				isolateKeys(event);
			}}
			ref={navRef}
		>
			<QueueGroup
				capped={false}
				count={groups.blocking.length}
				heading={needYouHeading(groups.blocking.length, tl)}
			>
				{(limit) => groups.blocking.slice(0, limit).map(askButton)}
			</QueueGroup>
			<QueueGroup
				capped
				count={groups.stopped.length}
				heading={plural(groups.stopped.length, "run stopped", "runs stopped")}
			>
				{(limit) =>
					groups.stopped.slice(0, limit).map((entry) => (
						<li key={entry.threadId}>
							<button
								aria-label={blockerAriaLabel(
									entry.blocker,
									entry.agentName,
									nowMs,
									privacy,
									clock
								)}
								className={QUEUE_BUTTON}
								data-ask-queue-item=""
								data-blocker-thread={entry.threadId}
								onClick={(event) =>
									onBlocker(
										entry.threadId,
										entry.agentName,
										event.currentTarget
									)
								}
								type="button"
							>
								{`${entry.agentName}: ${
									privacy === "redacted"
										? blockerKindWord(entry.blocker.kind)
										: entry.blocker.title
								}`}
							</button>
						</li>
					))
				}
			</QueueGroup>
			<QueueGroup
				capped
				count={groups.suggestions.length}
				heading={plural(groups.suggestions.length, "suggestion", "suggestions")}
			>
				{(limit) => groups.suggestions.slice(0, limit).map(askButton)}
			</QueueGroup>
			<QueueGroup
				capped
				count={groups.answers.length}
				heading={plural(groups.answers.length, "answer ready", "answers ready")}
			>
				{(limit) => groups.answers.slice(0, limit).map(askButton)}
			</QueueGroup>
		</nav>
	);
}
