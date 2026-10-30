import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useMemo,
	useState,
} from "react";
import { askOwners, ownerName } from "./interface-ask-card-core.ts";
import { AskCard } from "./interface-ask-card-dialog.tsx";
import { BlockerCard, queueButtons } from "./interface-blocker-card.tsx";

export {
	askOwners,
	isolateKeys,
	plainText,
} from "./interface-ask-card-core.ts";
export {
	AskCard,
	ageText,
	askerLine,
	expiryText,
} from "./interface-ask-card-dialog.tsx";
export {
	NeedYouButton,
	openQueue,
	QueueButton,
} from "./interface-ask-card-hud.tsx";
export {
	type AskQueueGroups,
	AskQueueList,
	askQueueGroups,
	needYouHeading,
	QUEUE_GROUP_CAP,
} from "./interface-ask-card-queue.tsx";
export {
	ActAgentList,
	ActAnnouncer,
	ActStatus,
	BlindSpotCaption,
	blindSpotText,
} from "./interface-ask-card-status.tsx";
export { resolveReturnFocus } from "./interface-blocker-card.tsx";

/**
 * The act layer's shared DOM: the ask card (the ONLY place an ask is
 * answered), the ask queue (in-stage, revealed on focus, and as the Queue
 * sheet), the HUD "N need you" and "Queue · N" buttons, the per-agent
 * status line and agent list, the live announcer and the blind-spot
 * caption. Every game renders these outside its Canvas and outside any
 * `role="application"` element. Each root stops keydown propagation, so a
 * game's own key handlers (Escape to step back, digit shortcuts) never see
 * keys pressed inside them; default Tab, Enter and Escape still work.
 *
 * Games open cards through `useActCards`, which also returns focus when a
 * card closes: to its opener if still on the page, else to the next queue
 * button, else to the game's `fallbackFocus` heading, never to the body.
 */

// ---------------------------------------------------------------------------
// Card controller
// ---------------------------------------------------------------------------

/** A card a game can open: an ask, or a stopped run's blocker. */
export type ActCardRequest =
	| { askId: string; kind: "ask" }
	| { agentName: string; kind: "blocker"; threadId: string };

interface OpenCard {
	opener: HTMLElement | null;
	/** The opener's place in the ask queue, for "the next queue button". */
	queueIndex: number;
	request: ActCardRequest;
}

/**
 * Opens ask and blocker cards for a game. `openAsk(askId)` and
 * `openBlocker(threadId, agentName)` remember the focused element as the
 * opener; render `element` once, anywhere in the game's DOM.
 */
export function useActCards({
	clock,
	fallbackFocus,
	nowMs,
	port,
	snapshot,
	acts,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	fallbackFocus: RefObject<HTMLElement | null>;
	nowMs: number;
	port: InterfacePort;
	snapshot: InterfaceSnapshot;
}): {
	element: ReactNode;
	openAsk: (askId: string, opener?: HTMLElement | null) => void;
	openBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement | null
	) => void;
} {
	const [open, setOpen] = useState<OpenCard | null>(null);
	const show = useCallback(
		(request: ActCardRequest, opener?: HTMLElement | null) => {
			const from =
				opener ??
				(typeof document === "undefined"
					? null
					: (document.activeElement as HTMLElement | null));
			const index = from ? queueButtons().indexOf(from) : -1;
			setOpen({ opener: from, queueIndex: index, request });
		},
		[]
	);
	const openAsk = useCallback(
		(askId: string, opener?: HTMLElement | null) =>
			show({ askId, kind: "ask" }, opener),
		[show]
	);
	const openBlocker = useCallback(
		(threadId: string, agentName: string, opener?: HTMLElement | null) =>
			show({ agentName, kind: "blocker", threadId }, opener),
		[show]
	);
	const owners = useMemo(() => askOwners(acts), [acts]);
	const close = useCallback(() => setOpen(null), []);
	let element: ReactNode = null;
	if (open?.request.kind === "ask") {
		const askId = open.request.askId;
		const ask = snapshot.asks?.find((item) => item.id === askId);
		element = (
			<AskCard
				askId={askId}
				clock={clock}
				fallbackFocus={fallbackFocus}
				key={askId}
				nowMs={nowMs}
				onClose={close}
				opener={open.opener}
				ownerName={ask ? ownerName(ask, acts, owners) : null}
				port={port}
				queueIndex={open.queueIndex}
				snapshot={snapshot}
			/>
		);
	} else if (open?.request.kind === "blocker") {
		element = (
			<BlockerCard
				agentName={open.request.agentName}
				clock={clock}
				fallbackFocus={fallbackFocus}
				key={open.request.threadId}
				nowMs={nowMs}
				onClose={close}
				opener={open.opener}
				port={port}
				queueIndex={open.queueIndex}
				snapshot={snapshot}
				threadId={open.request.threadId}
			/>
		);
	}
	return { element, openAsk, openBlocker };
}
