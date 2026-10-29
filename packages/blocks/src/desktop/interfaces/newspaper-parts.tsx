import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { type ReactNode, useEffect, useState } from "react";
import {
	type NewspaperStory,
	storyAge,
	storyByline,
	storyKicker,
} from "./newspaper-model.ts";

const MINUTE_MS = 60_000;

/** The current time, refreshed every minute so ages and the dateline stay honest. */
export function useNewspaperClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}

const KICKER_TONE: Record<ThreadStatus, string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-success",
	"your-turn": "text-primary",
};

/** Shared type for every small-caps label: kickers, box heads, the rule bar. */
export const SMALL_CAPS =
	"font-sans font-semibold text-[11px] uppercase leading-4 tracking-[0.08em]";

/**
 * The status line over a headline, in the color of its state, with the
 * section it is filed under. Live stories carry the one moving mark on the
 * page.
 */
export function StoryKicker({
	className,
	showSection = true,
	story,
}: {
	className?: string;
	showSection?: boolean;
	story: NewspaperStory;
}) {
	const section = showSection ? story.section?.name : undefined;
	return (
		<p className={cn("flex min-w-0 items-center gap-2", SMALL_CAPS, className)}>
			<span
				className={cn(
					"inline-flex shrink-0 items-center gap-1.5",
					KICKER_TONE[story.status]
				)}
			>
				{story.status === "working" ? (
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
					/>
				) : null}
				{storyKicker(story)}
			</span>
			{section ? (
				<>
					<span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
					<span className="truncate text-muted-foreground">{section}</span>
				</>
			) : null}
		</p>
	);
}

/** "By Forge · 12 min ago", with the timestamp machine-readable. */
export function StoryByline({
	className,
	detail,
	now,
	story,
}: {
	className?: string;
	/** Extra trailing fact, e.g. the message count on the lead. */
	detail?: string;
	now: number;
	story: NewspaperStory;
}) {
	return (
		<p
			className={cn(
				"flex flex-wrap items-baseline gap-x-2 font-sans text-muted-foreground text-xs leading-4",
				className
			)}
		>
			<span className="font-medium text-foreground">{storyByline(story)}</span>
			<time dateTime={story.thread.updatedAt}>
				{storyAge(story.thread.updatedAt, now)}
			</time>
			{detail ? <span>{detail}</span> : null}
		</p>
	);
}

/**
 * A headline that opens its story. The button's hit area is stretched over
 * the whole story block (the block is `relative group/story`), so a click
 * anywhere on the story opens it while only the headline is announced.
 */
export function StoryHeadline({
	as: Heading = "h3",
	className,
	onOpen,
	story,
}: {
	as?: "h2" | "h3" | "h4";
	className?: string;
	onOpen: (threadId: string) => void;
	story: NewspaperStory;
}) {
	return (
		<Heading className={cn("font-serif text-foreground", className)}>
			<button
				className="cursor-pointer text-balance text-left font-semibold font-serif decoration-1 underline-offset-[0.2em] outline-none after:absolute after:-inset-x-2 after:-inset-y-1.5 after:rounded-sm after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring group-hover/story:underline"
				data-thread-id={story.thread.id}
				onClick={() => onOpen(story.thread.id)}
				type="button"
			>
				{story.thread.title}
			</button>
		</Heading>
	);
}

/**
 * The latest message, set as the deck. A message you wrote is marked as
 * yours so the deck never reads as the agent's words.
 */
export function StoryDeck({
	className,
	story,
}: {
	className?: string;
	story: NewspaperStory;
}) {
	const message = story.thread.lastMessage?.trim();
	if (!message) {
		return null;
	}
	return (
		<p
			className={cn(
				"hyphens-auto text-pretty font-serif text-foreground/80",
				className
			)}
		>
			{story.thread.lastMessageRole === "user" ? (
				<span className="font-sans font-semibold text-[0.8em] text-muted-foreground uppercase tracking-[0.06em]">
					You{" "}
				</span>
			) : null}
			{message}
		</p>
	);
}

/** A box head: a full rule above a small-caps label. */
export function BoxHead({
	action,
	children,
	id,
}: {
	action?: ReactNode;
	children: ReactNode;
	id?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3 border-foreground border-t pt-2 pb-3">
			<h2 className="flex text-foreground leading-4" id={id}>
				<span className={SMALL_CAPS}>{children}</span>
			</h2>
			{action}
		</div>
	);
}
