import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { ArrowLeftToLine } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	LiveBrowse,
	type LiveBrowseTab,
	LiveCategoryPage,
	type LiveTileActions,
} from "./live-browse.tsx";
import { LiveChannelPage } from "./live-channel.tsx";
import { LiveChat } from "./live-chat.tsx";
import {
	liveCategories,
	liveChannels,
	liveFeatured,
	liveSearchCategories,
	liveSearchChannels,
	liveUnassigned,
} from "./live-model.ts";
import { liveOwnsKeys, useLiveNow, useLiveSize } from "./live-parts.tsx";
import { LiveRail } from "./live-rail.tsx";
import {
	LiveBrowseSkeleton,
	LiveEmpty,
	LiveRailSkeleton,
} from "./live-states.tsx";
import { LIVE_TILE_ATTRIBUTE } from "./live-tile.tsx";
import { LiveTopBar } from "./live-topbar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

type LiveRoute =
	| { kind: "browse" }
	| { id: string; kind: "category" }
	| { agentId: string; kind: "channel" };

/** Below this the rail folds to faces by default. */
const RAIL_WIDE_MIN = 1200;
/** Below this the rail is hidden and Browse is the way around. */
const RAIL_MIN = 720;
/** Below this chat covers the page instead of sitting beside it. */
const CHAT_SPLIT_MIN = 900;
/** Below this the channel's info bar stacks its actions. */
const INFO_COMPACT_MAX = 600;
/** Height kept for the top bar and the info bar under the player. */
const PLAYER_CHROME = 224;
/** Below this the top bar folds New thread to an icon. */
const TOPBAR_COMPACT_MAX = 640;

function chatWidthFor(width: number): number {
	return width >= 1280 ? 340 : 320;
}

function gutterFor(width: number): number {
	if (width < 640) {
		return 16;
	}
	return width < 1000 ? 24 : 32;
}

function firstAgentOf(
	threads: InterfaceRendererProps<unknown>["snapshot"]["threads"],
	threadId: string | null
): string | null {
	if (!threadId) {
		return null;
	}
	return threads.find((thread) => thread.id === threadId)?.agentIds[0] ?? null;
}

/**
 * Live: agents as channels, after Twitch on the web. The left rail lists
 * followed channels (live first, with what they stream); Browse is a grid of
 * 16:9 streams and a Categories directory of teams and projects. Opening a
 * channel shows its stream (the running or latest thread, captioned live),
 * the info bar, and its Videos, Schedule and About tabs. The right column is
 * the stream chat: the host's real conversation for the open thread.
 */
export function LiveInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["live"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const chatHeadingRef = useRef<HTMLHeadingElement>(null);
	const returnFocusId = useRef<string | null>(null);

	const size = useLiveSize(rootRef);
	const now = useLiveNow(60_000);
	const reduceMotion = useReducedMotion();
	const tl = useLiteralMessages();

	const activeAgentId = firstAgentOf(snapshot.threads, activeThreadId);
	const [route, setRoute] = useState<LiveRoute>(() =>
		activeAgentId
			? { agentId: activeAgentId, kind: "channel" }
			: { kind: "browse" }
	);
	const [tab, setTab] = useState<LiveBrowseTab>("channels");
	const [query, setQuery] = useState("");
	const [railChoice, setRailChoice] = useState<boolean | null>(null);
	const [chatChoice, setChatChoice] = useState<boolean | null>(null);

	const channels = useMemo(() => liveChannels(snapshot), [snapshot]);
	const categories = useMemo(
		() => liveCategories(snapshot, channels),
		[snapshot, channels]
	);
	const unassigned = useMemo(() => liveUnassigned(snapshot), [snapshot]);

	// Opening a thread from anywhere (the host, a video, a category) shows its
	// channel, unless the channel on screen is already one of its agents.
	useEffect(() => {
		if (!(activeThreadId && activeAgentId)) {
			return;
		}
		setRoute((previous) => {
			if (previous.kind !== "channel") {
				return { agentId: activeAgentId, kind: "channel" };
			}
			const thread = snapshot.threads.find(
				(candidate) => candidate.id === activeThreadId
			);
			return thread?.agentIds.includes(previous.agentId)
				? previous
				: { agentId: activeAgentId, kind: "channel" };
		});
		// Only a newly opened thread moves the page; snapshot refreshes do not.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	}, [activeThreadId, activeAgentId]);

	const channel =
		route.kind === "channel"
			? (channels.find((item) => item.agent.id === route.agentId) ?? null)
			: null;
	const categoryEntry =
		route.kind === "category"
			? (categories.find((entry) => entry.category.id === route.id) ?? null)
			: null;
	const page = channel ? "channel" : categoryEntry ? "category" : "browse";
	const featured = channel ? liveFeatured(channel, activeThreadId) : null;

	const open = threadView !== null && threadView !== undefined;
	const narrow = size.width < CHAT_SPLIT_MIN;
	const chatAvailable = page === "channel" || open;
	const chatHidden = chatChoice ?? narrow;
	const chatShown = chatAvailable && !chatHidden;
	const chatWidth = chatWidthFor(size.width);
	const railShown = size.width >= RAIL_MIN;
	const railCollapsed = railChoice ?? size.width < RAIL_WIDE_MIN;
	const railWidth = railShown ? (railCollapsed ? 56 : 240) : 0;
	const mainWidth =
		size.width - railWidth - (chatShown && !narrow ? chatWidth : 0);
	const gutter = gutterFor(mainWidth);
	// The player never pushes the channel's title below the fold.
	const playerMaxWidth = Math.max(
		480,
		Math.round(((size.height - PLAYER_CHROME) * 16) / 9)
	);

	const scrollTop = useCallback(() => {
		scrollRef.current?.scrollTo({ top: 0 });
	}, []);

	const leave = useCallback(
		(next: LiveRoute) => {
			if (open) {
				port.closeThread();
			}
			setRoute(next);
			scrollTop();
		},
		[open, port, scrollTop]
	);

	const watch = useCallback(
		(agentId: string) => {
			const target = channels.find((item) => item.agent.id === agentId);
			returnFocusId.current = agentId;
			setQuery("");
			setRoute({ agentId, kind: "channel" });
			scrollTop();
			if (target?.current) {
				if (target.current.id !== activeThreadId) {
					port.openThread(target.current.id);
				}
			} else if (open) {
				port.closeThread();
			}
		},
		[activeThreadId, channels, open, port, scrollTop]
	);

	const openThread = useCallback(
		(threadId: string) => {
			setQuery("");
			scrollTop();
			if (threadId !== activeThreadId) {
				port.openThread(threadId);
			}
		},
		[activeThreadId, port, scrollTop]
	);

	const showCategory = useCallback(
		(categoryId: string) => {
			setQuery("");
			leave({ id: categoryId, kind: "category" });
		},
		[leave]
	);

	const browse = useCallback(() => {
		setQuery("");
		leave({ kind: "browse" });
	}, [leave]);

	const changeQuery = useCallback(
		(next: string) => {
			setQuery(next);
			if (route.kind !== "browse" && next.trim()) {
				leave({ kind: "browse" });
			}
		},
		[leave, route.kind]
	);

	const startNew = useCallback(() => port.startThread({}), [port]);

	// Leaving a channel hands focus back to the tile it was opened from.
	useEffect(() => {
		if (page !== "browse" || !returnFocusId.current) {
			return;
		}
		const id = returnFocusId.current;
		returnFocusId.current = null;
		const tile = scrollRef.current?.querySelector<HTMLElement>(
			`[${LIVE_TILE_ATTRIBUTE}="${CSS.escape(id)}"]`
		);
		tile?.focus({ preventScroll: true });
	}, [page]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (event.defaultPrevented || event.metaKey || event.ctrlKey) {
				return;
			}
			if (event.key === "/" && !liveOwnsKeys(event.target)) {
				event.preventDefault();
				searchRef.current?.focus();
				return;
			}
			if (event.key !== "Escape" || liveOwnsKeys(event.target)) {
				return;
			}
			if (narrow && chatShown) {
				event.preventDefault();
				setChatChoice(true);
			} else if (page !== "browse") {
				event.preventDefault();
				browse();
			} else if (open) {
				event.preventDefault();
				port.closeThread();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [browse, chatShown, narrow, open, page, port]);

	const actions: LiveTileActions = {
		activeThreadId,
		now,
		onCategory: showCategory,
		onOpenThread: openThread,
		onWatch: watch,
	};

	const searchedChannels = liveSearchChannels(channels, query);
	const searchedCategories = liveSearchCategories(categories, query);
	const empty = snapshot.agents.length === 0 && snapshot.threads.length === 0;

	let body: ReactNode;
	if (loading) {
		body = <LiveBrowseSkeleton gutter={gutter} />;
	} else if (channel) {
		body = (
			<LiveChannelPage
				actions={actions}
				channel={channel}
				chatHidden={chatHidden}
				compact={mainWidth < INFO_COMPACT_MAX}
				featured={featured}
				gutter={gutter}
				key={channel.agent.id}
				onMessage={() => port.startThread({ agentId: channel.agent.id })}
				onShowChat={() => setChatChoice(false)}
				playerMaxWidth={playerMaxWidth}
				reduceMotion={reduceMotion}
				snapshot={snapshot}
			/>
		);
	} else if (categoryEntry) {
		body = (
			<LiveCategoryPage
				actions={actions}
				entry={categoryEntry}
				gutter={gutter}
				snapshot={snapshot}
			/>
		);
	} else if (empty) {
		body = <LiveEmpty gutter={gutter} onNew={startNew} />;
	} else {
		body = (
			<LiveBrowse
				actions={actions}
				categories={searchedCategories}
				channels={searchedChannels}
				gutter={gutter}
				onClearQuery={() => setQuery("")}
				onTab={setTab}
				query={query}
				snapshot={snapshot}
				tab={tab}
				unassigned={unassigned}
			/>
		);
	}

	let rail: ReactNode = null;
	if (railShown && loading) {
		rail = <LiveRailSkeleton collapsed={railCollapsed} />;
	} else if (railShown) {
		rail = (
			<LiveRail
				channels={channels}
				collapsed={railCollapsed}
				onSelect={watch}
				onToggle={() => setRailChoice(!railCollapsed)}
				selectedId={channel?.agent.id ?? null}
			/>
		);
	}

	return (
		<div
			aria-busy={loading ? "true" : undefined}
			className="flex size-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
			data-page={page}
			data-testid="interface-live"
			ref={rootRef}
		>
			<LiveTopBar
				browsing={page === "browse"}
				compact={size.width < TOPBAR_COMPACT_MAX}
				onBrowse={browse}
				onNew={startNew}
				onQuery={changeQuery}
				query={query}
				searchRef={searchRef}
			/>
			<div className="relative flex min-h-0 flex-1">
				{rail}
				<main
					aria-label={
						channel
							? tl("{name} channel", { name: channel.agent.name })
							: "Browse"
					}
					className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
					inert={narrow && chatShown}
					ref={scrollRef}
				>
					{body}
				</main>
				{chatShown ? (
					<LiveChat
						agent={channel?.agent ?? null}
						headingRef={chatHeadingRef}
						onCollapse={() => setChatChoice(true)}
						onSend={(prompt) => {
							if (channel) {
								port.startThread({ agentId: channel.agent.id, prompt });
							}
						}}
						overlay={narrow}
						reduceMotion={reduceMotion}
						threadView={threadView}
						width={chatWidth}
					/>
				) : null}
				{chatAvailable && chatHidden && !narrow ? (
					<Button
						aria-label="Expand chat"
						className="absolute top-2 right-2 z-10 bg-background/85 text-muted-foreground hover:text-foreground"
						onClick={() => setChatChoice(false)}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						<ArrowLeftToLine aria-hidden="true" className="size-4" />
					</Button>
				) : null}
			</div>
		</div>
	);
}
