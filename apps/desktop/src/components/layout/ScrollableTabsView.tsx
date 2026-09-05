import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
	type WheelEvent,
} from "react";
import { TabLayoutMenuItems } from "@/src/components/layout/appearance-context-menu.tsx";
import { TabViewPane } from "@/src/components/layout/TabViewPane.tsx";
import type {
	Split,
	Tab,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { TabGlyph } from "./TitleBar.tsx";

const GROUP_SURFACE_CLASSES: Record<TabGroupColor, string> = {
	grey: "border-slate-500/30 bg-slate-500/5",
	blue: "border-info/35 bg-info/5",
	red: "border-destructive/35 bg-destructive/5",
	yellow: "border-warning/35 bg-warning/5",
	green: "border-success/35 bg-success/5",
	pink: "border-pink-500/35 bg-pink-500/5",
	purple: "border-purple-500/35 bg-purple-500/5",
	cyan: "border-cyan-500/35 bg-cyan-500/5",
	orange: "border-orange-500/35 bg-orange-500/5",
};

interface TabCluster {
	color: TabGroupColor;
	label: string;
}

function clusterFor(
	tab: Tab,
	groups: TabGroup[],
	splits: Split[]
): TabCluster | undefined {
	if (tab.groupId) {
		const group = groups.find((candidate) => candidate.id === tab.groupId);
		if (group) {
			return { color: group.color, label: group.name };
		}
	}
	if (tab.splitId) {
		const split = splits.find((candidate) => candidate.id === tab.splitId);
		if (split) {
			return {
				color: split.color,
				label: split.name || "Pane group",
			};
		}
	}
	return undefined;
}

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);

	useEffect(() => {
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	return reduced;
}

function TabCardHeader({
	cluster,
	focused,
	onClose,
	onFocus,
	tab,
	tabLayout,
}: {
	cluster?: TabCluster;
	focused: boolean;
	onClose: () => void;
	onFocus: () => void;
	tab: Tab;
	tabLayout: ReturnType<typeof useTabLayout>;
}) {
	const surface = cluster
		? GROUP_SURFACE_CLASSES[cluster.color]
		: "border-border/70 bg-card";
	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						className={cn(
							"flex min-h-12 items-center gap-2 border-b px-3 py-2",
							surface
						)}
						data-tab-view-header={tab.id}
					>
						<TabGlyph
							busy={tab.busy}
							busySpeed={tab.busySpeed}
							className={cn(
								"size-4 shrink-0",
								focused ? "text-foreground" : "text-muted-foreground"
							)}
							icon={tab.icon}
							logoSize="16px"
							path={tab.path}
							unloaded={tab.unloaded}
						/>
						<button
							className={cn(
								"min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								focused ? "text-foreground" : "text-muted-foreground"
							)}
							onClick={onFocus}
							type="button"
						>
							<OverflowTooltip
								className="block overflow-hidden whitespace-nowrap font-medium text-sm"
								fade
								forceShow={tab.unloaded}
								text={tab.title}
							/>
						</button>
						{cluster && (
							<span className="hidden shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide sm:inline">
								{cluster.label}
							</span>
						)}
						<button
							aria-label={`Close ${tab.title}`}
							className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={(event) => {
								event.stopPropagation();
								onClose();
							}}
							type="button"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</button>
					</div>
				}
			/>
			<ContextMenuContent>
				<ContextMenuItem disabled={focused} onClick={onFocus}>
					Focus tab
				</ContextMenuItem>
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
				<ContextMenuItem onClick={onClose}>Close tab</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function ScrollableTabsView() {
	const { activeTabId, closeTab, focusTab, openTab, tabs, groups, splits } =
		useTabsContext();
	const tabLayout = useTabLayout();
	const reducedMotion = useReducedMotion();
	const scrollRef = useRef<HTMLDivElement>(null);
	const cardRefs = useRef(new Map<string, HTMLDivElement>());
	const activeIdRef = useRef(activeTabId);
	const frameRef = useRef<number | null>(null);

	useEffect(() => {
		activeIdRef.current = activeTabId;
	}, [activeTabId]);

	useEffect(() => {
		const card = cardRefs.current.get(activeTabId);
		card?.scrollIntoView({
			behavior: reducedMotion ? "auto" : "smooth",
			block: "nearest",
			inline: "center",
		});
	}, [activeTabId, reducedMotion]);

	useEffect(() => {
		return () => {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current);
			}
		};
	}, []);

	const focusNearestCard = useCallback(() => {
		const container = scrollRef.current;
		if (!container) {
			return;
		}
		const center =
			container.getBoundingClientRect().left + container.clientWidth / 2;
		let nearest: { distance: number; id: string } | undefined;
		for (const [id, card] of cardRefs.current) {
			const rect = card.getBoundingClientRect();
			const distance = Math.abs(rect.left + rect.width / 2 - center);
			if (!nearest || distance < nearest.distance) {
				nearest = { distance, id };
			}
		}
		if (nearest && nearest.id !== activeIdRef.current) {
			activeIdRef.current = nearest.id;
			focusTab(nearest.id);
		}
	}, [focusTab]);

	const handleScroll = () => {
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current);
		}
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null;
			focusNearestCard();
		});
	};

	const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
		const element = scrollRef.current;
		if (!element || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
			return;
		}
		event.preventDefault();
		element.scrollLeft += event.deltaY;
	};

	const handleCardKeyDown = (
		event: KeyboardEvent<HTMLDivElement>,
		index: number
	) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
			return;
		}
		event.preventDefault();
		const nextIndex = index + (event.key === "ArrowRight" ? 1 : -1);
		const nextTab = tabs[nextIndex];
		if (!nextTab) {
			return;
		}
		focusTab(nextTab.id);
		cardRefs.current.get(nextTab.id)?.scrollIntoView({
			behavior: reducedMotion ? "auto" : "smooth",
			block: "nearest",
			inline: "center",
		});
	};

	return (
		<section
			aria-label="Scrollable tabs"
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background pt-12"
			data-tab-layout={tabLayout}
			data-testid="scrollable-tabs-view"
		>
			<header className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
				<div>
					<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
						Center view
					</p>
					<h1 className="font-medium text-sm">Scrollable tabs</h1>
				</div>
				<button
					aria-label="New chat tab"
					className="flex size-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => openTab("/chat", { forceNew: true })}
					type="button"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
				</button>
			</header>
			<div
				aria-label="Open tabs"
				className="flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden px-[11vw] pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				data-testid="scrollable-tabs-track"
				onScroll={handleScroll}
				onWheel={handleWheel}
				ref={scrollRef}
				role="list"
			>
				{tabs.map((tab, index) => {
					const cluster = clusterFor(tab, groups, splits);
					return (
						<div
							aria-label={`${tab.title} tab card`}
							className="h-full min-h-0 w-[78vw] max-w-[760px] shrink-0 snap-center rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							data-focused={tab.id === activeTabId}
							data-tab-view-card={tab.id}
							key={tab.id}
							onKeyDown={(event) => handleCardKeyDown(event, index)}
							onMouseDown={() => focusTab(tab.id)}
							ref={(element) => {
								if (element) {
									cardRefs.current.set(tab.id, element);
								} else {
									cardRefs.current.delete(tab.id);
								}
							}}
							role="listitem"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: each live card is a keyboard focus target for left/right tab navigation
							tabIndex={0}
						>
							<TabViewPane
								className="h-full rounded-2xl border border-border/70 shadow-sm"
								focused={tab.id === activeTabId}
								onClose={() => closeTab(tab.id)}
								onFocus={() => focusTab(tab.id)}
								tab={tab}
							>
								<TabCardHeader
									cluster={cluster}
									focused={tab.id === activeTabId}
									onClose={() => closeTab(tab.id)}
									onFocus={() => focusTab(tab.id)}
									tab={tab}
									tabLayout={tabLayout}
								/>
							</TabViewPane>
						</div>
					);
				})}
			</div>
		</section>
	);
}
