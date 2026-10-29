import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { PanelRight, X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useId } from "react";
import { compactAge } from "./interface-renderer.ts";
import { PostsAvatar } from "./posts-avatar.tsx";
import { PostMarkerLabel } from "./posts-marker.tsx";
import {
	absoluteTime,
	markerLabel,
	type PostItem,
	type PostSpace,
} from "./posts-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const ICON_BUTTON =
	"flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:text-foreground";

function DetailRow({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="grid min-h-9 grid-cols-[88px_minmax(0,1fr)] items-center gap-3">
			<dt className="text-muted-foreground text-sm leading-6">{label}</dt>
			<dd className="min-w-0 text-foreground text-sm leading-6">{children}</dd>
		</div>
	);
}

function Participant({ agent }: { agent: InterfaceAgent }) {
	return (
		<li className="flex h-6 min-w-0 items-center gap-2">
			<PostsAvatar agent={agent} size={20} />
			<span className="truncate">{agent.name}</span>
			{agent.status === "working" ? (
				<span className="ml-auto shrink-0 text-status-success text-xs">
					Working
				</span>
			) : null}
		</li>
	);
}

export interface PostDetailsProps {
	item: PostItem;
	now: number;
	/** Shown when the rail floats over the page at narrow widths. */
	onClose: (() => void) | null;
	onSelectSpace: (space: PostSpace) => void;
}

/** The right rail: where the post lives, who is on it, and where it stands. */
export function PostDetails({
	item,
	now,
	onClose,
	onSelectSpace,
}: PostDetailsProps) {
	const headingId = useId();
	const { space, thread } = item;
	return (
		<aside
			aria-labelledby={headingId}
			className={cn(
				"flex w-[288px] shrink-0 flex-col overflow-y-auto border-border border-l bg-background",
				onClose && "absolute inset-y-0 right-0 z-20 shadow-lg"
			)}
			data-testid="posts-details"
		>
			<div className="flex h-12 shrink-0 items-center gap-2 px-5">
				<h2 className="flex-1 font-medium text-sm" id={headingId}>
					Details
				</h2>
				{onClose ? (
					<button
						aria-label="Close details"
						className={cn(ICON_BUTTON, "-mr-2")}
						onClick={onClose}
						type="button"
					>
						<X aria-hidden="true" className="size-4" strokeWidth={1.75} />
					</button>
				) : null}
			</div>
			<dl className="px-5 pb-6">
				<DetailRow label="Status">
					<PostMarkerLabel
						className="text-sm leading-6"
						label={markerLabel(item)}
						marker={item.marker}
					/>
				</DetailRow>
				<DetailRow label="Space">
					{space ? (
						<button
							className="max-w-full truncate rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={() => onSelectSpace(space)}
							type="button"
						>
							{space.name}
						</button>
					) : (
						<span className="text-muted-foreground">None</span>
					)}
				</DetailRow>
				<DetailRow label="Author">
					<span className="flex h-6 min-w-0 items-center gap-2">
						<PostsAvatar agent={item.author} size={20} />
						<span className="truncate">{item.author?.name ?? "You"}</span>
					</span>
				</DetailRow>
				<DetailRow label="Comments">
					<span className="tabular-nums">{item.comments}</span>
				</DetailRow>
				<DetailRow label="Updated">
					<time
						dateTime={thread.updatedAt}
						title={absoluteTime(thread.updatedAt)}
					>
						{absoluteTime(thread.updatedAt)}
						<span className="text-muted-foreground">
							{" "}
							· {compactAge(thread.updatedAt, now)}
						</span>
					</time>
				</DetailRow>
				{thread.pinned ? <DetailRow label="Pinned">Yes</DetailRow> : null}
			</dl>
			{item.commenters.some((agent) => agent !== item.author) ? (
				<section
					aria-label="Participants"
					className="border-border border-t px-5 py-5"
				>
					<h3 className="pb-2 text-muted-foreground text-sm">
						Participants
						<span className="pl-1.5 tabular-nums">
							{item.commenters.length}
						</span>
					</h3>
					<ul className="flex flex-col gap-2 text-sm">
						{item.commenters.map((agent) => (
							<Participant agent={agent} key={agent.id} />
						))}
					</ul>
				</section>
			) : null}
		</aside>
	);
}

export interface PostPageProps {
	backLabel: string;
	detailsFloating: boolean;
	detailsOpen: boolean;
	item: PostItem | null;
	now: number;
	onBack: () => void;
	onCloseDetails: () => void;
	onSelectSpace: (space: PostSpace) => void;
	onToggleDetails: () => void;
	ref?: Ref<HTMLElement>;
	/** Narrow layouts show a sidebar toggle in the page bar. */
	sidebarToggle: ReactNode;
	threadView: ReactNode;
}

/**
 * The top bar's place: the view the post was opened from (the one way back,
 * same as Esc), then the post's title.
 */
function Breadcrumb({
	backLabel,
	item,
	onBack,
}: {
	backLabel: string;
	item: PostItem | null;
	onBack: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center">
			<ol className="flex min-w-0 items-center gap-1 text-sm">
				<li className="flex min-w-0 shrink-0 items-center gap-1">
					<button
						aria-keyshortcuts="Escape"
						className="h-8 max-w-48 truncate rounded-md px-2 text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
						onClick={onBack}
						title={tl("Back to {backLabel} (Esc)", { backLabel })}
						type="button"
					>
						{backLabel}
					</button>
					<span aria-hidden="true" className="text-muted-foreground/60">
						/
					</span>
				</li>
				<li
					aria-current="page"
					className="min-w-0 truncate px-2 font-medium text-foreground"
				>
					{item?.thread.title || "New post"}
				</li>
			</ol>
		</nav>
	);
}

/**
 * An open post: a page bar, the post itself (author, time, title; the
 * messages live below, so nothing is repeated above them),
 * then the host's real conversation as the comments, and the details rail.
 */
export function PostPage({
	backLabel,
	detailsFloating,
	detailsOpen,
	item,
	now,
	onBack,
	onCloseDetails,
	onSelectSpace,
	onToggleDetails,
	ref,
	sidebarToggle,
	threadView,
}: PostPageProps) {
	const reduceMotion = useReducedMotion();
	const titleId = useId();
	const commentsId = useId();
	const thread = item?.thread;
	return (
		<motion.section
			animate={{ opacity: 1 }}
			aria-labelledby={titleId}
			className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none"
			data-testid="posts-page"
			initial={reduceMotion ? false : { opacity: 0 }}
			ref={ref}
			tabIndex={-1}
			transition={{ duration: 0.16, ease: "easeOut" }}
		>
			<div className="flex h-12 shrink-0 items-center gap-1 border-border border-b px-3">
				{sidebarToggle}
				<Breadcrumb backLabel={backLabel} item={item} onBack={onBack} />
				{item ? (
					<button
						aria-label="Details"
						aria-pressed={detailsOpen}
						className={ICON_BUTTON}
						onClick={onToggleDetails}
						title="Details (I)"
						type="button"
					>
						<PanelRight
							aria-hidden="true"
							className="size-4"
							strokeWidth={1.75}
						/>
					</button>
				) : null}
			</div>
			<div className="relative flex min-h-0 flex-1">
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<header className="mx-auto w-full max-w-[800px] shrink-0 px-6 pt-8 pb-6">
						{item && thread ? (
							<>
								<div className="flex min-w-0 items-center gap-2 text-sm leading-6">
									<PostsAvatar agent={item.author} size={24} />
									<span className="truncate font-medium text-foreground">
										{item.author?.name ?? "You"}
									</span>
									<span aria-hidden="true" className="text-muted-foreground">
										·
									</span>
									<time
										className="shrink-0 text-muted-foreground tabular-nums"
										dateTime={thread.updatedAt}
										title={absoluteTime(thread.updatedAt)}
									>
										{compactAge(thread.updatedAt, now)}
									</time>
									{detailsOpen ? null : (
										<PostMarkerLabel
											className="ml-auto shrink-0 pl-3 text-sm"
											label={markerLabel(item)}
											marker={item.marker}
										/>
									)}
								</div>
								<h1
									className="mt-4 text-balance text-2xl text-foreground leading-8 tracking-[-0.015em]"
									id={titleId}
								>
									<span className="font-semibold">
										{thread.title || "Untitled post"}
									</span>
								</h1>
							</>
						) : (
							<h1
								className="text-2xl text-foreground leading-8 tracking-[-0.015em]"
								id={titleId}
							>
								<span className="font-semibold">New post</span>
							</h1>
						)}
					</header>
					<section
						aria-labelledby={commentsId}
						className="mx-auto flex min-h-0 w-full max-w-[800px] flex-1 flex-col"
					>
						<h2
							className="mx-6 flex h-11 shrink-0 items-center gap-1.5 border-border border-t font-medium text-foreground text-sm"
							id={commentsId}
						>
							Comments
							{item && item.comments > 0 ? (
								<span className="text-muted-foreground tabular-nums">
									{item.comments}
								</span>
							) : null}
						</h2>
						<div
							className="flex min-h-0 flex-1 flex-col px-2"
							data-testid="posts-thread-view"
						>
							{threadView}
						</div>
					</section>
				</div>
				{item && detailsOpen ? (
					<PostDetails
						item={item}
						now={now}
						onClose={detailsFloating ? onCloseDetails : null}
						onSelectSpace={onSelectSpace}
					/>
				) : null}
			</div>
		</motion.section>
	);
}
