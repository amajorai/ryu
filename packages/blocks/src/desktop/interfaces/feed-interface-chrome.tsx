import { Button } from "@ryu/ui/components/button.tsx";
import {
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { FeedPost, ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { KeyboardEvent, ReactNode } from "react";
import { needsYou } from "./feed-model.ts";
import type { FeedView } from "./feed-nav.tsx";
import { FEED_META } from "./feed-parts.tsx";

export type HomeTab = "for-you" | "needs-you";

export const HOME_TABS: { id: HomeTab; label: string }[] = [
	{ id: "for-you", label: "For you" },
	{ id: "needs-you", label: "Needs you" },
];

export const VIEW_TITLES: Record<
	Exclude<FeedView, "home" | "search">,
	string
> = {
	agents: "Agents",
	pinned: "Pinned",
	working: "Working",
};

export function matchesQuery(post: FeedPost, query: string): boolean {
	return (
		post.title.toLowerCase().includes(query) ||
		post.excerpt.toLowerCase().includes(query)
	);
}

export function postsForView(
	posts: FeedPost[],
	view: FeedView,
	homeTab: HomeTab,
	statuses: ReadonlyMap<string, ThreadStatus>
): FeedPost[] {
	if (view === "pinned") {
		return posts.filter((post) => post.pinned);
	}
	if (view === "working") {
		return posts.filter((post) => post.running);
	}
	if (view === "home" && homeTab === "needs-you") {
		return posts.filter((post) =>
			needsYou(statuses.get(post.threadId) ?? "quiet")
		);
	}
	return posts;
}

/** Bold headline, one plain sentence, optional primary pill. */
export function FeedEmpty({
	action,
	body,
	title,
}: {
	action?: { label: string; onClick: () => void };
	body: string;
	title: string;
}) {
	return (
		<div className="mx-auto flex max-w-[400px] flex-col items-start px-8 py-10">
			<h2 className="font-heading font-semibold! text-3xl text-foreground leading-9 tracking-tight">
				{title}
			</h2>
			<p className={cn("mt-2 text-[15px] leading-5", FEED_META)}>{body}</p>
			{action ? (
				<Button
					className="mt-7 h-12 rounded-full px-8 font-semibold text-base"
					onClick={action.onClick}
					type="button"
				>
					{action.label}
				</Button>
			) : null}
		</div>
	);
}

/** Sticky column header on the solid page background. */
export function StickyHeader({
	bordered = true,
	children,
}: {
	bordered?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"sticky top-0 z-20 bg-background",
				bordered && "border-border border-b"
			)}
		>
			{children}
		</div>
	);
}

export function isHomeTab(value: unknown): value is HomeTab {
	return HOME_TABS.some((item) => item.id === value);
}

/**
 * For you / Needs you, on the design system's line tabs. As on X, the active
 * bar sits under the label and takes its width, so it is drawn on the label
 * span rather than the half-width trigger. Keyboard focus fills the cell like
 * hover does and rings the label, so no hard rectangle crosses the hairline.
 */
export function HomeTabs() {
	return (
		<TabsList
			activateOnFocus
			aria-label="Timeline"
			className="w-full gap-0 p-0 group-data-horizontal/tabs:h-[53px]"
			manageLayout={false}
			persistLayout={false}
			variant="line"
		>
			{HOME_TABS.map(({ id, label }) => (
				<TabsTrigger
					className="group/tab after:hidden! h-full! flex-1! rounded-none! px-4 py-0! font-normal text-[15px] text-foreground outline-none! ring-0! hover:bg-muted/60 hover:text-foreground focus-visible:border-transparent! focus-visible:bg-muted/60 data-active:font-semibold data-active:text-foreground dark:text-foreground dark:data-active:text-foreground"
					data-tab={id}
					key={id}
					value={id}
				>
					<span className="relative inline-flex h-full items-center after:absolute after:inset-x-0 after:bottom-0 after:h-1 after:rounded-full after:bg-primary after:opacity-0 group-data-active/tab:after:opacity-100">
						<span className="-mx-1 rounded-sm px-1 group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring">
							{label}
						</span>
					</span>
				</TabsTrigger>
			))}
			{/* TabsList adds a full-width indicator when none is given; the bar lives on the label instead. */}
			<TabsIndicator className="hidden!" />
		</TabsList>
	);
}

export function ViewTitle({ title }: { title: string }) {
	return (
		<div className="flex h-[53px] items-center px-4">
			<h2 className="font-heading font-semibold! text-foreground text-xl leading-6">
				{title}
			</h2>
		</div>
	);
}

/** Move focus between posts with j / k, the timeline's own shortcut keys. */
export function onTimelineKeyDown(event: KeyboardEvent<HTMLElement>) {
	if (event.key !== "j" && event.key !== "k") {
		return;
	}
	const target = event.target;
	if (!(target instanceof HTMLElement && target.dataset.feedPost)) {
		return;
	}
	const buttons = [
		...event.currentTarget.querySelectorAll<HTMLButtonElement>(
			"button[data-feed-post]"
		),
	];
	const index = buttons.indexOf(target as HTMLButtonElement);
	const next = buttons[index + (event.key === "j" ? 1 : -1)];
	if (next) {
		event.preventDefault();
		next.focus();
		next.scrollIntoView({ block: "nearest" });
	}
}
