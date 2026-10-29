import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, MessageSquarePlus, Play } from "lucide-react";
import { motion } from "motion/react";
import {
	type CinemaTitle,
	cinemaAge,
	cinemaMessages,
	cinemaStatusText,
} from "./cinema-model.ts";
import { CinemaBoxart } from "./cinema-poster.tsx";
import { compactAge } from "./interface-renderer.ts";

/** A poster's box, in the catalogue frame's coordinates. */
export interface CinemaRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

/** How much the preview grows over the poster it came from. */
const GROW = 1.5;
const MIN_WIDTH = 288;
/** Height of the info block under the art (buttons, meta, tags). */
const INFO_HEIGHT = 128;

/** Where the preview sits: centered on its poster, kept inside the gutters. */
export function cinemaPreviewBox(
	rect: CinemaRect,
	frameWidth: number,
	frameHeight: number,
	gutter: number
): { left: number; originX: number; top: number; width: number } {
	const width = Math.round(Math.max(rect.width * GROW, MIN_WIDTH));
	const artHeight = (width * 9) / 16;
	const centerX = rect.left + rect.width / 2;
	const minLeft = Math.min(gutter, rect.left);
	const maxLeft = Math.max(
		minLeft,
		Math.max(frameWidth - gutter, rect.left + rect.width) - width
	);
	const left = Math.round(
		Math.min(maxLeft, Math.max(minLeft, centerX - width / 2))
	);
	const posterArtCenter = rect.top + (rect.width * 9) / 16 / 2;
	const maxTop = Math.max(8, frameHeight - artHeight - INFO_HEIGHT - 8);
	const top = Math.round(
		Math.min(maxTop, Math.max(8, posterArtCenter - artHeight / 2))
	);
	return { left, originX: (centerX - left) / width, top, width };
}

const STATUS_TONE: Record<CinemaTitle["status"], string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-success",
	"your-turn": "text-primary",
};

export interface CinemaPreviewProps {
	frameHeight: number;
	frameWidth: number;
	gutter: number;
	now: number;
	onClose: () => void;
	onKeep: () => void;
	onMore: (threadId: string, opener: HTMLElement) => void;
	onNew: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	rect: CinemaRect;
	reduceMotion: boolean;
	title: CinemaTitle;
}

/**
 * The card a resting pointer grows out of a poster: the art again, larger,
 * then Open, a new thread with the same agent, and More info, with the
 * title's state, size and age, and who and where it belongs.
 */
export function CinemaPreview({
	frameHeight,
	frameWidth,
	gutter,
	now,
	onClose,
	onKeep,
	onMore,
	onNew,
	onOpen,
	rect,
	reduceMotion,
	title,
}: CinemaPreviewProps) {
	const tl = useLiteralMessages();
	const box = cinemaPreviewBox(rect, frameWidth, frameHeight, gutter);
	const thread = title.thread;
	const agent = title.agents[0];
	const tags = [
		...title.agents.map((item) => item.name),
		title.group?.name ?? "",
	].filter(Boolean);
	const circle =
		"flex size-9 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";
	return (
		<motion.div
			animate={{ opacity: 1, scale: 1 }}
			aria-label={tl("Preview: {title}", { title: thread.title })}
			className="absolute z-40 overflow-hidden rounded-md bg-card text-card-foreground shadow-2xl ring-1 ring-border"
			data-testid="cinema-preview"
			exit={{ opacity: 0, scale: reduceMotion ? 1 : 1 / GROW }}
			initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1 / GROW }}
			onPointerEnter={onKeep}
			onPointerLeave={onClose}
			role="group"
			style={{
				left: box.left,
				top: box.top,
				transformOrigin: `${(box.originX * 100).toFixed(1)}% 25%`,
				width: box.width,
			}}
			transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: "easeOut" }}
		>
			<button
				aria-label={tl("More info: {title}", { title: thread.title })}
				className="block w-full cursor-pointer outline-none"
				onClick={(event) => onMore(thread.id, event.currentTarget)}
				tabIndex={-1}
				type="button"
			>
				<CinemaBoxart size="large" title={title} />
			</button>
			<div className="flex flex-col gap-3 p-4">
				<div className="flex items-center gap-2">
					<button
						aria-label={tl("Open {title}", { title: thread.title })}
						className={cn(
							circle,
							"bg-foreground text-background hover:bg-foreground/80"
						)}
						onClick={() => onOpen(thread.id)}
						title="Open"
						type="button"
					>
						<Play aria-hidden="true" className="ml-0.5 size-4 fill-current" />
					</button>
					{agent ? (
						<button
							aria-label={tl("New thread with {name}", { name: agent.name })}
							className={cn(
								circle,
								"border-2 border-foreground/40 text-foreground hover:border-foreground"
							)}
							onClick={() => onNew(agent.id)}
							title={tl("New thread with {name}", { name: agent.name })}
							type="button"
						>
							<MessageSquarePlus aria-hidden="true" className="size-4" />
						</button>
					) : null}
					<button
						aria-label={tl("More info: {title}", { title: thread.title })}
						className={cn(
							circle,
							"ml-auto border-2 border-foreground/40 text-foreground hover:border-foreground"
						)}
						onClick={(event) => onMore(thread.id, event.currentTarget)}
						title="More info"
						type="button"
					>
						<ChevronDown aria-hidden="true" className="size-5" />
					</button>
				</div>
				<p className="flex items-baseline gap-3 text-sm leading-5">
					<span className={cn("font-semibold", STATUS_TONE[title.status])}>
						{cinemaStatusText(title)}
					</span>
					<span className="text-foreground/80">
						{cinemaMessages(thread.messageCount)}
					</span>
					<span className="text-foreground/80">
						{cinemaAge(compactAge(thread.updatedAt, now))}
					</span>
				</p>
				<p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm leading-5">
					{tags.length > 0 ? (
						tags.map((tag, index) => (
							<span className="flex items-center gap-1.5" key={tag}>
								{index > 0 ? (
									<span aria-hidden="true" className="text-muted-foreground/60">
										•
									</span>
								) : null}
								<span className="truncate">{tag}</span>
							</span>
						))
					) : (
						<span className="text-muted-foreground">No agent</span>
					)}
				</p>
			</div>
		</motion.div>
	);
}
