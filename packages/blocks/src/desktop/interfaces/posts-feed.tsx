import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Pin } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useId } from "react";
import { compactAge } from "./interface-renderer.ts";
import { PostsAvatar, PostsFacepile, ROW_FACE_RING } from "./posts-avatar.tsx";
import { PostMarkerLabel } from "./posts-marker.tsx";
import {
	commentLabel,
	markerLabel,
	type PostItem,
	type PostSection,
} from "./posts-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

export interface PostRowProps {
	/** Home's sections already name the state, so rows there leave it out. */
	hideMarker?: boolean;
	item: PostItem;
	now: number;
	onOpen: (threadId: string) => void;
	registerRow: (threadId: string, element: HTMLButtonElement | null) => void;
	/** Hide "in <space>" when the feed is already that space. */
	showSpace: boolean;
}

/**
 * One post in the feed: author and time, a strong title, the latest message
 * as the preview, then who is in the thread, how many comments, and state.
 * The title is the row's one control; it stretches over the whole row.
 */
export function PostRow({
	hideMarker = false,
	item,
	now,
	onOpen,
	registerRow,
	showSpace,
}: PostRowProps) {
	const titleId = useId();
	const { thread } = item;
	const comments = commentLabel(item.comments);
	const authorName = item.author?.name ?? "You";
	return (
		<article
			aria-labelledby={titleId}
			className="group/post relative -mx-4 grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 rounded-lg px-4 py-4 transition-colors duration-100 hover:bg-muted has-[:focus-visible]:bg-muted"
			data-marker={item.marker}
			data-thread-id={thread.id}
		>
			<PostsAvatar agent={item.author} className="mt-0.5" size={32} />
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
					<span className="truncate font-medium text-foreground">
						{authorName}
					</span>
					{showSpace && item.space ? (
						<span className="hidden min-w-0 truncate text-muted-foreground sm:inline">
							in {item.space.name}
						</span>
					) : null}
					<span aria-hidden="true" className="text-muted-foreground">
						·
					</span>
					<time
						className="shrink-0 text-muted-foreground tabular-nums"
						dateTime={thread.updatedAt}
					>
						{compactAge(thread.updatedAt, now)}
					</time>
					{thread.pinned ? (
						<span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
							<Pin aria-hidden="true" className="size-3.5" strokeWidth={2} />
							<span className="text-[13px]">Pinned</span>
						</span>
					) : null}
				</div>
				<h3 className="mt-1 font-semibold text-base text-foreground leading-6 tracking-[-0.005em]">
					<button
						className="text-left font-semibold outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
						id={titleId}
						onClick={() => onOpen(thread.id)}
						ref={(element) => registerRow(thread.id, element)}
						type="button"
					>
						{thread.title || "Untitled post"}
					</button>
				</h3>
				{thread.lastMessage ? (
					<p className="mt-1 line-clamp-2 text-[15px] text-foreground/75 leading-6">
						{thread.lastMessageRole === "user" && item.author ? (
							<span className="font-medium text-foreground/90">You: </span>
						) : null}
						{thread.lastMessage}
					</p>
				) : null}
				<div className="mt-3 flex min-w-0 items-center gap-3 text-[13px] leading-5">
					{item.commenters.length > 0 && comments ? (
						<span className="flex shrink-0 items-center gap-2 text-muted-foreground">
							<PostsFacepile
								agents={item.commenters}
								ringClassName={ROW_FACE_RING}
							/>
							{comments}
						</span>
					) : (
						<span className="shrink-0 text-muted-foreground">
							{comments ?? "No comments yet"}
						</span>
					)}
					{hideMarker ? null : (
						<PostMarkerLabel label={markerLabel(item)} marker={item.marker} />
					)}
				</div>
			</div>
		</article>
	);
}

export interface PostListProps {
	hideMarker?: boolean;
	items: readonly PostItem[];
	now: number;
	onOpen: (threadId: string) => void;
	registerRow: (threadId: string, element: HTMLButtonElement | null) => void;
	showSpace: boolean;
}

/** Posts in order, with a short settle-in when the list changes. */
export function PostList({
	hideMarker,
	items,
	now,
	onOpen,
	registerRow,
	showSpace,
}: PostListProps) {
	const reduceMotion = useReducedMotion();
	return (
		<ul className="flex flex-col">
			{items.map((item, index) => (
				<motion.li
					animate={{ opacity: 1, y: 0 }}
					initial={reduceMotion ? false : { opacity: 0, y: 4 }}
					key={item.thread.id}
					transition={{
						delay: Math.min(index, 8) * 0.025,
						duration: 0.18,
						ease: "easeOut",
					}}
				>
					<PostRow
						hideMarker={hideMarker}
						item={item}
						now={now}
						onOpen={onOpen}
						registerRow={registerRow}
						showSpace={showSpace}
					/>
				</motion.li>
			))}
		</ul>
	);
}

/** Home: one titled group per state that needs you. */
export function PostSections({
	sections,
	...rest
}: Omit<PostListProps, "items"> & { sections: readonly PostSection[] }) {
	return (
		<div className="flex flex-col">
			{sections.map((section, index) => (
				<section
					aria-labelledby={`posts-section-${section.marker}`}
					className={cn(index > 0 && "mt-4 border-border border-t pt-4")}
					key={section.marker}
				>
					<h2
						className="flex h-9 items-center gap-2 text-foreground text-sm"
						id={`posts-section-${section.marker}`}
					>
						<span className="font-medium">{section.label}</span>
						<span className="text-muted-foreground tabular-nums">
							{section.items.length}
						</span>
					</h2>
					<PostList hideMarker items={section.items} {...rest} />
				</section>
			))}
		</div>
	);
}

const SKELETON_KEYS = ["one", "two", "three", "four"];

export function PostsSkeleton() {
	return (
		<div aria-hidden="true" className="flex flex-col">
			{SKELETON_KEYS.map((key) => (
				<div
					className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 py-4"
					key={key}
				>
					<Skeleton className="size-8" radius="pill" />
					<div className="flex flex-col gap-2 pt-1">
						<Skeleton className="h-3 w-32" radius="dense" />
						<Skeleton className="h-4 w-3/5" radius="dense" />
						<Skeleton className="h-3 w-full" radius="dense" />
						<Skeleton className="h-3 w-4/5" radius="dense" />
						<Skeleton className="mt-1 h-3 w-40" radius="dense" />
					</div>
				</div>
			))}
		</div>
	);
}

export function PostsEmpty({
	action,
	body,
	className,
	title,
}: {
	action?: ReactNode;
	body: string;
	className?: string;
	title: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-start gap-1 border-border border-t py-10",
				className
			)}
		>
			<p className="font-medium text-foreground text-sm">{title}</p>
			<p className="max-w-sm text-muted-foreground text-sm leading-6">{body}</p>
			{action ? <div className="pt-3">{action}</div> : null}
		</div>
	);
}

export function PostsEmptyAction({
	children,
	onClick,
}: {
	children: string;
	onClick: () => void;
}) {
	return (
		<Button onClick={onClick} size="sm" type="button" variant="outline">
			{children}
		</Button>
	);
}
