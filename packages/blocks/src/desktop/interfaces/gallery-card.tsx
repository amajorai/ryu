import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { MessageCirclePlus, Pin } from "lucide-react";
import { motion } from "motion/react";
import { useId } from "react";
import { GalleryAvatarStack } from "./gallery-avatar.tsx";
import { GalleryCover } from "./gallery-cover.tsx";
import { type GalleryItem, galleryByline } from "./gallery-model.ts";
import { compactAge } from "./interface-renderer.ts";

const EASE_OUT: [number, number, number, number] = [0.2, 0, 0, 1];
/** Cards after this many share one entrance delay, so long boards stay quick. */
const STAGGER_CAP = 12;

/** Data attribute that marks a card's main button, for focus restoration. */
export const GALLERY_CARD_ATTRIBUTE = "data-gallery-card";

/**
 * One pin: the cover built from the conversation, then the title and a byline underneath. The
 * whole card is one button that opens the thread; hovering (or focusing it)
 * dims the cover and reveals the quick actions, like a pin board.
 */
export function GalleryCard({
	index,
	item,
	now,
	onMessage,
	onOpen,
	reduceMotion,
}: {
	index: number;
	item: GalleryItem;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	reduceMotion: boolean;
}) {
	const tl = useLiteralMessages();
	const describedBy = useId();
	const { agents, cover, status, thread } = item;
	const age = compactAge(thread.updatedAt, now);
	const lead = agents[0];
	return (
		<motion.div
			animate={{ opacity: 1, y: 0 }}
			className="group/card @container/card relative"
			data-status={status}
			data-thread-id={thread.id}
			initial={reduceMotion ? false : { opacity: 0, y: 8 }}
			role="listitem"
			transition={{
				delay: Math.min(index, STAGGER_CAP) * 0.025,
				duration: 0.24,
				ease: EASE_OUT,
			}}
		>
			<div className="relative overflow-hidden rounded-2xl bg-muted">
				<GalleryCover cover={cover} />
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 bg-foreground/20 opacity-0 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100 motion-reduce:transition-none dark:bg-background/45"
				/>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute top-2 right-2 z-10 inline-flex h-8 items-center rounded-full bg-primary px-3 font-medium text-primary-foreground text-sm opacity-0 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100 motion-reduce:transition-none"
				>
					Open
				</span>
				{lead ? (
					<button
						aria-label={tl("Message {name}", { name: lead.name })}
						className={cn(
							"absolute right-2 bottom-2 z-10 inline-flex h-8 items-center gap-1.5 rounded-full bg-background px-3 font-medium text-foreground text-sm opacity-0 outline-none transition-[opacity,background-color] duration-150 hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-focus-within/card:opacity-100 group-hover/card:opacity-100 motion-reduce:transition-none",
							"@max-[13rem]/card:w-8 @max-[13rem]/card:justify-center @max-[13rem]/card:px-0"
						)}
						onClick={() => onMessage(lead.id)}
						type="button"
					>
						<MessageCirclePlus
							aria-hidden="true"
							className="size-4"
							strokeWidth={2}
						/>
						<span className="@max-[13rem]/card:sr-only">Message</span>
					</button>
				) : null}
			</div>
			<div className="flex flex-col gap-1.5 px-1 pt-2.5">
				<h3 className="line-clamp-2 font-semibold text-[15px] text-foreground leading-5 tracking-tight">
					{thread.title}
				</h3>
				<div className="flex h-5 min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
					{agents.length > 0 ? <GalleryAvatarStack agents={agents} /> : null}
					<span className="min-w-0 truncate">{galleryByline(agents)}</span>
					<span className="ms-auto flex shrink-0 items-center gap-1.5 tabular-nums">
						{thread.pinned ? (
							<Pin aria-hidden="true" className="size-3" strokeWidth={2} />
						) : null}
						{status === "your-turn" ? (
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-primary"
							/>
						) : null}
						{age}
					</span>
				</div>
			</div>
			<span className="sr-only" id={describedBy}>
				{[
					THREAD_STATUS_LABELS[status],
					galleryByline(agents),
					thread.pinned ? "Pinned" : null,
					age ? `Updated ${age}` : null,
				]
					.filter(Boolean)
					.join(", ")}
			</span>
			<button
				aria-describedby={describedBy}
				className="absolute -inset-1 rounded-[1.25rem] outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => onOpen(thread.id)}
				type="button"
				{...{ [GALLERY_CARD_ATTRIBUTE]: thread.id }}
			>
				<span className="sr-only">{thread.title}</span>
			</button>
		</motion.div>
	);
}

/** Placeholder heights for the loading board, varied like real covers. */
const SKELETON_RATIOS: readonly number[] = [1.33, 1, 1.5, 1.25, 0.8, 1.33];

export function GalleryCardSkeleton({ seed }: { seed: number }) {
	const ratio = SKELETON_RATIOS[seed % SKELETON_RATIOS.length] ?? 1;
	return (
		<div aria-hidden="true" className="flex flex-col">
			<Skeleton className="w-full" style={{ aspectRatio: `1 / ${ratio}` }} />
			<div className="flex flex-col gap-2 px-1 pt-3">
				<Skeleton className="h-3.5 w-4/5" radius="pill" />
				<div className="flex items-center gap-1.5">
					<Skeleton className="size-5" radius="pill" />
					<Skeleton className="h-3 w-16" radius="pill" />
				</div>
			</div>
		</div>
	);
}
