import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "@ryu/ui/components/sheet.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ClockOptions,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { BellRing, ListChecks } from "lucide-react";
import {
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { GAME_FOCUS } from "./game-hud.tsx";
import { type ActTotals, NARROW_STAGE } from "./game3d-acts.ts";
import { isolateKeys } from "./interface-ask-card-core.ts";
import { AskQueueList } from "./interface-ask-card-queue.tsx";

// ---------------------------------------------------------------------------
// HUD buttons
// ---------------------------------------------------------------------------

const HUD_ACTION = cn(
	"gk-action gk-display pointer-events-auto inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-(--gk-accent) ps-4 pe-5 text-(--gk-accent-ink) text-[18px] [&_svg]:size-5 [&_svg]:shrink-0",
	GAME_FOCUS
);

/** "3 need you": opens the card of the first ask in queue order. */
export function NeedYouButton({
	onAsk,
	snapshot,
	totals,
}: {
	onAsk: (askId: string, opener: HTMLElement) => void;
	snapshot: Pick<InterfaceSnapshot, "asks">;
	totals: Pick<ActTotals, "needYou">;
}) {
	const tl = useLiteralMessages();
	const first = (snapshot.asks ?? [])
		.filter((ask) => ask.blocking)
		.sort(compareAsks)[0];
	if (!first || totals.needYou === 0) {
		return null;
	}
	return (
		<button
			className={HUD_ACTION}
			data-need-you=""
			onClick={(event) => onAsk(first.id, event.currentTarget)}
			onKeyDown={isolateKeys}
			type="button"
		>
			<BellRing aria-hidden="true" />
			{tl("{needYou} need you", { needYou: String(totals.needYou) })}
		</button>
	);
}

function useNarrow(narrow: boolean | undefined): boolean {
	const [wide, setWide] = useState(true);
	useEffect(() => {
		if (
			narrow !== undefined ||
			typeof window === "undefined" ||
			!window.matchMedia
		) {
			return;
		}
		const query = window.matchMedia(`(min-width: ${NARROW_STAGE}px)`);
		const update = () => setWide(query.matches);
		update();
		query.addEventListener?.("change", update);
		return () => query.removeEventListener?.("change", update);
	}, [narrow]);
	return narrow ?? !wide;
}

/**
 * Opens the Queue sheet through a `QueueButton`'s `openRef` (for tallies);
 * without one (no queue button on the page), moves focus into the in-stage
 * queue so the tap still leads somewhere.
 */
export function openQueue(openRef: RefObject<(() => void) | null>): void {
	if (openRef.current) {
		openRef.current();
		return;
	}
	if (typeof document === "undefined") {
		return;
	}
	document
		.querySelector<HTMLElement>(
			"[data-ask-queue='reveal'] [data-ask-queue-item]"
		)
		?.focus();
}

/**
 * "Queue · N": the visible, tappable path to everything in the queue (N =
 * blocking asks + stopped runs + suggestions + unread answers). Opens the
 * queue as a popover, or a bottom sheet on narrow stages; choosing an
 * item closes it and opens that card, and focus comes back here after.
 * Absent when N is 0.
 */
export function QueueButton({
	acts,
	clock,
	narrow,
	nowMs,
	onAsk,
	onBlocker,
	snapshot,
	totals,
	unowned,
	openRef,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	narrow?: boolean;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	/** Lets a tally plate open this sheet. */
	openRef?: RefObject<(() => void) | null>;
	snapshot: InterfaceSnapshot;
	totals: Pick<ActTotals, "queue">;
	unowned: readonly InterfaceAsk[];
}) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const isNarrow = useNarrow(narrow);
	const empty = totals.queue === 0;
	useEffect(() => {
		if (empty) {
			// Nothing to show: no opener for tallies, and never pop up later.
			setOpen(false);
			if (openRef) {
				openRef.current = null;
			}
			return;
		}
		if (!openRef) {
			return;
		}
		openRef.current = () => setOpen(true);
		return () => {
			openRef.current = null;
		};
	}, [empty, openRef]);
	if (empty) {
		return null;
	}
	const label = `Queue · ${totals.queue}`;
	// The kit stops key propagation inside its DOM, which also keeps Escape
	// from the dismiss listener on the document: close on Escape here.
	const keepKeys = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			setOpen(false);
		}
		isolateKeys(event);
	};
	const list = (
		<AskQueueList
			acts={acts}
			clock={clock}
			mode="sheet"
			nowMs={nowMs}
			onAsk={(askId) => {
				setOpen(false);
				onAsk(askId, trigger.current ?? document.body);
			}}
			onBlocker={(threadId, agentName) => {
				setOpen(false);
				onBlocker(threadId, agentName, trigger.current ?? document.body);
			}}
			snapshot={snapshot}
			unowned={unowned}
		/>
	);
	const button = (
		<button
			className={HUD_ACTION}
			data-queue-button=""
			onKeyDown={isolateKeys}
			ref={trigger}
			type="button"
		>
			<ListChecks aria-hidden="true" />
			{label}
		</button>
	);
	if (isNarrow) {
		return (
			<Sheet onOpenChange={setOpen} open={open}>
				<SheetTrigger render={button} />
				<SheetContent
					className="gap-3 p-4 pb-6"
					onKeyDown={keepKeys}
					side="bottom"
				>
					<SheetTitle>Queue</SheetTitle>
					{list}
				</SheetContent>
			</Sheet>
		);
	}
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger render={button} />
			<PopoverContent
				align="end"
				className="w-96 max-w-[calc(100vw-2rem)]"
				onKeyDown={keepKeys}
			>
				{list}
			</PopoverContent>
		</Popover>
	);
}
