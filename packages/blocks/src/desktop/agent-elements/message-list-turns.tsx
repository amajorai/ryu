import { useLiteralMessages } from "@ryu/i18n/react";
import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { startOfTodayMs, useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { useEffect, useMemo, useRef } from "react";
import type { ChatTocItem } from "./chat-toc.tsx";
import {
	dayDividersKey,
	groupTurnsByDay,
	separatorKeyByTurnIndex,
} from "./date-groups.ts";
import { useTranscriptAnchor } from "./hooks/use-transcript-anchor.ts";
import type { useMessageListFollow } from "./message-list-follow.ts";
import {
	type AssistantTurn,
	EMPTY_TURN_SET,
	getChangedFilesFromParts,
	getLastAssistantHasContent,
	getPlanningActivity,
	getTextFromParts,
	groupMessagesIntoTurns,
	PLANNING_LABELS,
	reuseSettledTurns,
} from "./message-list-helpers.ts";
import type { MessageListBaseScope } from "./message-list-scope.ts";
import { shouldShowPlanning } from "./planning-visibility.ts";
import { hasVisibleContentAtNoDetail } from "./tool-detail-visibility.ts";
import { widgetMessageProvenanceKey } from "./types.ts";
import { isInterruptedMessage } from "./utils/live-message-observations.ts";
import type { TranscriptScrollEvent } from "./utils/transcript-scroll-event.ts";

export type UseMessageListTurnsInput = MessageListBaseScope &
	ReturnType<typeof useMessageListFollow>;

/** Planning state, the grouped turns, day separators, transcript anchors and the rail. */
export function useMessageListTurns({
	normalizedMessages,
	assistantPlanningAvatars,
	assistantAvatar,
	isStreaming,
	hideToolDetail,
	isCompact,
	viewportRef,
	scrollerRef,
	onMessageVisible,
	assistantName,
}: UseMessageListTurnsInput) {
	const tl = useLiteralMessages();
	const planningLabel =
		PLANNING_LABELS[getPlanningActivity(normalizedMessages)];
	// Who is on the turn, drawn in the row's leading slot. Several agents overlap
	// slightly (`-space-x-1`) so three marks still read as one group rather than a
	// row of loose icons; a single agent is unaffected by the negative margin.
	// `undefined` (not an empty node) when there is nothing to draw, so the
	// planning row leads with the typing indicator alone.
	const planningMarks = (
		assistantPlanningAvatars?.length
			? assistantPlanningAvatars
			: [assistantAvatar]
	).filter(Boolean);
	const planningLeading =
		planningMarks.length > 0 ? (
			<span className="flex shrink-0 items-center -space-x-1">
				{planningMarks.map((mark, index) => (
					<span className="flex size-4 items-center justify-center" key={index}>
						{mark}
					</span>
				))}
			</span>
		) : undefined;
	// Settled turns keep their identity across streamed chunks (see
	// `reuseSettledTurns`), which is what lets each memoised turn row skip the
	// render. Reconciled against the last COMMITTED turns, like the entrance
	// state, so a render React discards cannot leak into the next one.
	const committedTurnsRef = useRef<AssistantTurn[]>([]);
	const rawTurns = useMemo(
		() =>
			reuseSettledTurns(
				committedTurnsRef.current,
				groupMessagesIntoTurns(normalizedMessages)
			),
		[normalizedMessages]
	);
	useEffect(() => {
		committedTurnsRef.current = rawTurns;
	}, [rawTurns]);
	// Computed BEFORE the detail filter below, and off `rawTurns`, because
	// whether an assistant message exists at all is a fact about the stream, not
	// about how much of it we draw.
	const showPlanning = useMemo(() => {
		const lastMessage = normalizedMessages.at(-1);
		const lastTurn = rawTurns.at(-1);
		return shouldShowPlanning({
			hasMessages: Boolean(lastMessage),
			lastMessageIsUser: lastMessage?.role === "user",
			lastTurnHasAssistant: Boolean(
				lastTurn && lastTurn.assistantMsgs.length > 0
			),
			isStreaming,
			lastAssistantHasContent: getLastAssistantHasContent(
				normalizedMessages,
				hideToolDetail
			),
		});
	}, [hideToolDetail, isStreaming, normalizedMessages, rawTurns]);

	// --- Detail level "None" -----------------------------------------------
	// A turn whose whole content is tool detail renders nothing at None. Left in
	// the list it would still emit a `MessageScrollerItem`: an empty row that
	// occupies a scroll slot and carries a content-visibility placeholder, i.e.
	// a blank gap in the transcript. So the turn is dropped OUTRIGHT rather than
	// replaced with a minimal "n steps hidden" row — such a row is a tool row
	// under another name and would defeat the point of the level. What keeps
	// that safe: failed tool rows are never hidden, `type: "error"` parts are
	// never hidden, and an interrupted turn counts as visible below — the
	// interruption marker is metadata now (`_interrupted`), not a text part, so
	// a turn that died with nothing but hidden tool work would otherwise vanish
	// entirely at None and take its crash notice with it.
	//
	// Filtering HERE (not at render time) is deliberate: `separatorKeyByTurnIndex`
	// keys day separators by turn index, so dropping a turn later would leave a
	// separator pointing at a turn that no longer exists.
	//
	// Two turns are always kept:
	//  • one with a user message — the prompt is the user's own text, and an
	//    assistant reply that was pure tool work simply shows no reply bubble;
	//  • the last one while `showPlanning` is on — it is the row's only home,
	//    and dropping it would strand a running agent with no liveness cue.
	const { turns, assistantHiddenTurns } = useMemo(() => {
		if (!hideToolDetail) {
			return { turns: rawTurns, assistantHiddenTurns: EMPTY_TURN_SET };
		}
		const hidden = new Set<AssistantTurn>();
		for (const turn of rawTurns) {
			const visible = turn.assistantMsgs.some(
				(msg) =>
					hasVisibleContentAtNoDetail(msg.parts ?? []) ||
					isInterruptedMessage(msg)
			);
			if (!visible) {
				hidden.add(turn);
			}
		}
		const kept = rawTurns.filter(
			(turn, index) =>
				Boolean(turn.userMsg) ||
				!hidden.has(turn) ||
				(index === rawTurns.length - 1 && showPlanning)
		);
		return { turns: kept, assistantHiddenTurns: hidden };
	}, [hideToolDetail, rawTurns, showPlanning]);

	// --- day grouping ------------------------------------------------------
	// The display time zone is a GROUPING input here, not just a label input:
	// it decides where midnight falls, so changing Appearance → "Date & time"
	// MOVES a separator rather than just retitling one. Subscribing (rather than
	// letting the formatters read the zone at call time, as most surfaces do) is
	// what makes these memos recompute instead of leaving a stale boundary on
	// screen. `useExhaustiveDependencies` is off repo-wide, so the revision sits
	// in the dep arrays below without a suppression; it is intentional, not a
	// leftover.
	const tzRevision = useTimezoneRevision();
	const dayGroups = useMemo(() => groupTurnsByDay(turns), [turns, tzRevision]);
	const separatorKeys = useMemo(
		() => separatorKeyByTurnIndex(dayGroups),
		[dayGroups]
	);
	// Same row key as transcript-turn.tsx, so the floating date pill re-observes
	// whenever a divider lands on a newly mounted row (older history paging).
	const dividersKey = useMemo(
		() =>
			dayDividersKey(
				dayGroups,
				(index) => turns[index]?.userMsg?.id ?? `turn-${index}`
			),
		[dayGroups, turns]
	);
	// "Today"/"Yesterday" are relative to the current civil day, so the zone
	// revision alone leaves a mounted transcript saying "Today" after midnight.
	// The shared display-day store owns one bounded timer plus focus/visibility
	// wakes for every mounted consumer, and its revision changes at each
	// display-zone midnight (23- and 25-hour DST days included).
	const dayRevision = useDisplayDayRevision();
	const startOfToday = useMemo(
		() => startOfTodayMs(),
		[tzRevision, dayRevision]
	);
	// Anchor id → flat turn index, so the floating header can map the scroller's
	// `currentAnchorId` back onto a group. Normal turns use the user message id;
	// assistant-only turns (for example a page-tool result) use their first
	// assistant message so a newly appended result remains scrollable and visible.
	const turnIndexByAnchorId = useMemo(() => {
		const byId = new Map<string, number>();
		for (const [index, turn] of turns.entries()) {
			const anchorId = turn.userMsg?.id ?? turn.assistantMsgs[0]?.id;
			if (anchorId) {
				byId.set(anchorId, index);
			}
		}
		return byId;
	}, [turns]);

	// Anchor ids in DOM order. The beUI MessageScroller owns scroll-follow but
	// exposes no anchor API, so the transcript tracks "which turn is at the top"
	// itself — including assistant-only page-tool results.
	const transcriptAnchorIds = useMemo(
		() =>
			turns
				.map((turn) => turn.userMsg?.id ?? turn.assistantMsgs[0]?.id)
				.filter((id): id is string => Boolean(id)),
		[turns]
	);
	const {
		currentAnchorId,
		registerAnchor: registerTranscriptAnchor,
		scrollToMessage,
	} = useTranscriptAnchor({
		anchorIds: transcriptAnchorIds,
		enabled: !isCompact,
		viewportRef,
	});

	// A receipt is recorded when a user-authored message actually enters the
	// viewport, not merely when the conversation is opened. The observer is kept
	// here because this is the shared transcript's one stable message-row DOM
	// boundary; callers only receive the durable message id.
	useEffect(() => {
		if (!onMessageVisible || globalThis.IntersectionObserver === undefined) {
			return;
		}
		const container = scrollerRef.current;
		if (!container) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) {
						continue;
					}
					const messageId = entry.target.getAttribute("data-message-id");
					if (messageId) {
						onMessageVisible(messageId);
					}
				}
			},
			{ root: viewportRef.current, threshold: 0.1 }
		);
		const rows = container.querySelectorAll<HTMLElement>(
			'[data-slot="message-scroller-item"][data-message-id]'
		);
		for (const row of rows) {
			observer.observe(row);
		}
		return () => observer.disconnect();
	}, [onMessageVisible, turns]);

	// --- messaging-style user runs -----------------------------------------
	// A "run" is consecutive messages from the same speaker: one avatar for the
	// whole run, tight spacing inside it. Only the USER side needs computing.
	// `groupMessagesIntoTurns` opens a new turn on every user message and joins
	// every assistant message to the current one, so `turn.assistantMsgs` IS the
	// assistant run and already draws as ONE `Message` with one avatar and one
	// header. A user run, by the same rule, spans consecutive TURNS — i.e.
	// sibling `MessageScrollerItem`s — which is exactly why it cannot be a
	// wrapper element: `MessageScrollerContent`'s MutationObserver watches
	// `childList` with no `subtree`, so a new turn appended inside a per-run
	// wrapper would fire no mutation and scroll-new-turn-to-top would die
	// silently. The run is therefore carried as `data-group-position` on each
	// item plus a computed avatar flag, never as a container.
	//
	// A run continues past turn i when all of these hold:
	//  • turn i draws no assistant reply — the other party breaks a run;
	//  • a next turn exists AND opens with a user message;
	//  • no day separator falls between them — a new day starts a fresh run,
	//    which is what Telegram/WhatsApp do and what keeps the avatar attached
	//    to the block the separator introduces.
	// `assistantHiddenTurns` is consulted rather than `assistantMsgs.length`
	// because at Detail level "None" a turn of pure tool work draws NOTHING, and
	// an invisible reply must not break a run the reader sees as continuous.
	const userRunPositions = useMemo(() => {
		const continues = turns.map((turn, index) => {
			const nextUserMsg = turns[index + 1]?.userMsg;
			const drawsAssistant =
				turn.assistantMsgs.length > 0 && !assistantHiddenTurns.has(turn);
			return Boolean(
				turn.userMsg &&
					!drawsAssistant &&
					nextUserMsg &&
					widgetMessageProvenanceKey(turn.userMsg) ===
						widgetMessageProvenanceKey(nextUserMsg) &&
					!separatorKeys.has(index + 1)
			);
		});
		return turns.map((_turn, index) => {
			const isLast = !continues[index];
			const isFirst = index === 0 || !continues[index - 1];
			if (isFirst && isLast) {
				return "single" as const;
			}
			if (isFirst) {
				return "first" as const;
			}
			return isLast ? ("last" as const) : ("middle" as const);
		});
	}, [turns, assistantHiddenTurns, separatorKeys]);

	// Built from the FILTERED turns, so a turn None dropped gets no entry. The
	// per-entry `files` list survives None on purpose: the TOC is navigation
	// ("jump to where that file changed"), not a tool row, and stripping it
	// would leave the aid weaker without making the transcript any quieter.
	const tocItems = useMemo<ChatTocItem[]>(() => {
		const items: ChatTocItem[] = [];
		for (const turn of turns) {
			if (!turn.userMsg) {
				continue;
			}
			const text = getTextFromParts(turn.userMsg.parts ?? [], " ").trim();
			if (!text) {
				continue;
			}
			const title = text.length > 80 ? `${text.slice(0, 80)}…` : text;
			const assistantParts = turn.assistantMsgs.flatMap((m) => m.parts ?? []);
			const reply = getTextFromParts(assistantParts, " ").trim();
			const description =
				reply.length > 160 ? `${reply.slice(0, 160)}…` : reply || undefined;
			items.push({
				id: turn.userMsg.id,
				title,
				description,
				agentAvatar: assistantAvatar,
				agentName: assistantName,
				files: getChangedFilesFromParts(assistantParts),
			});
		}
		return items;
	}, [turns, assistantAvatar, assistantName]);

	// The beUI rail's items: one tick per user turn, keyed by that message's id
	// (matched to the row's `data-message-id` for scroll targeting). Each item
	// carries the full TOC entry so the rail's preview card can render our info.
	const railItems = useMemo<PreviewRailItem[]>(
		() =>
			tocItems.map((item) => ({
				id: item.id,
				label: item.title,
				description: item.description,
				ariaLabel: tl("Go to message: {title}", { title: item.title }),
				data: item,
			})),
		[tocItems, tl]
	);

	// Sidebar / deep-link jump: ChatPage and AppSidebar dispatch this once
	// messages hydrate. The beUI rail has no event surface of its own, so the
	// listener lives here next to the scroll target it drives.
	useEffect(() => {
		const onJump = (event: TranscriptScrollEvent) => {
			const messageId = event.detail?.messageId;
			if (messageId) {
				scrollToMessage(messageId);
			}
		};
		window.addEventListener("ryu:scroll-to-message", onJump);
		return () => window.removeEventListener("ryu:scroll-to-message", onJump);
	}, [scrollToMessage]);
	return {
		planningLabel,
		planningLeading,
		showPlanning,
		turns,
		assistantHiddenTurns,
		dayGroups,
		dividersKey,
		separatorKeys,
		startOfToday,
		turnIndexByAnchorId,
		currentAnchorId,
		registerTranscriptAnchor,
		userRunPositions,
		railItems,
	} as const;
}
