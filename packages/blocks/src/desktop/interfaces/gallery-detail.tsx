import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { ArrowLeft, MessageCirclePlus } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { GalleryAvatar } from "./gallery-avatar.tsx";
import { GalleryCard } from "./gallery-card.tsx";
import { GalleryCover } from "./gallery-cover.tsx";
import { type GalleryItem, galleryColumns } from "./gallery-model.ts";
import { compactAge } from "./interface-renderer.ts";

/** Gutter inside the "More like this" shelf. */
const SHELF_GAP = 12;
/** The detail cover keeps its own shape up to this height-over-width. */
const DETAIL_MAX_RATIO = 0.9;
/** The detail column's horizontal padding (px-6), for the shelf's width. */
const DETAIL_PADDING = 24;

function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
	return (
		<Button
			aria-label={label}
			className="-ms-2"
			onClick={onBack}
			radius="pill"
			size="sm"
			variant="ghost"
		>
			<ArrowLeft aria-hidden="true" data-icon="inline-start" />
			Gallery
		</Button>
	);
}

function DetailFacts({ item, now }: { item: GalleryItem; now: number }) {
	const { groupName, status, thread } = item;
	const facts: { label: string; value: ReactNode }[] = [
		{
			label: "Status",
			value: (
				<span className="inline-flex items-center gap-2">
					<BoardStatusDot status={status} />
					{THREAD_STATUS_LABELS[status]}
				</span>
			),
		},
	];
	if (groupName) {
		facts.push({
			label: thread.projectId ? "Project" : "Team",
			value: groupName,
		});
	}
	facts.push(
		{
			label: "Messages",
			value: thread.messageCount.toLocaleString(),
		},
		{
			label: "Updated",
			value:
				compactAge(thread.updatedAt, now) === "now"
					? "Just now"
					: `${compactAge(thread.updatedAt, now)} ago`,
		}
	);
	return (
		<dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2 text-sm">
			{facts.map((fact) => (
				<div className="contents" key={fact.label}>
					<dt className="text-muted-foreground">{fact.label}</dt>
					<dd className="min-w-0 truncate text-foreground">{fact.value}</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * The pin page: the open thread's cover, title, owner and facts in a column
 * with "More like this" underneath, and the host's real conversation beside
 * it. When the frame is too narrow for both, the conversation takes the page
 * under a slim back bar.
 */
export function GalleryDetail({
	columnWidth,
	compact,
	headingRef,
	item,
	now,
	onBack,
	onMessage,
	onOpen,
	reduceMotion,
	related,
	threadView,
}: {
	columnWidth: number;
	compact: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	item: GalleryItem | null;
	now: number;
	onBack: () => void;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	reduceMotion: boolean;
	related: GalleryItem[];
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const title = item?.thread.title ?? "New conversation";
	const conversation = (
		<section
			aria-label="Conversation"
			className="min-h-0 min-w-0 flex-1"
			data-testid="gallery-thread-view"
		>
			{threadView}
		</section>
	);

	if (compact || !item) {
		return (
			<div className="flex size-full min-h-0 flex-col">
				<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
					<BackButton label="Back to gallery" onBack={onBack} />
					<h2
						className="min-w-0 truncate font-semibold text-foreground text-sm outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
				</header>
				{conversation}
			</div>
		);
	}

	const { agents, cover, thread } = item;
	const lead = agents[0];
	const shelfWidth = (columnWidth - DETAIL_PADDING * 2 - SHELF_GAP) / 2;
	const shelf = galleryColumns(related, 2, shelfWidth, SHELF_GAP);

	return (
		<div className="flex size-full min-h-0">
			<motion.aside
				animate={{ opacity: 1, x: 0 }}
				aria-label="Conversation details"
				className="flex min-h-0 shrink-0 flex-col border-border border-e"
				initial={reduceMotion ? false : { opacity: 0, x: -8 }}
				style={{ width: columnWidth }}
				transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
			>
				<header className="flex h-14 shrink-0 items-center px-6">
					<BackButton label="Back to gallery" onBack={onBack} />
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
					<div className="overflow-hidden rounded-2xl bg-muted">
						<GalleryCover
							cover={cover}
							ratio={Math.min(cover.ratio, DETAIL_MAX_RATIO)}
						/>
					</div>
					<h2
						className="mt-6 text-balance font-semibold text-2xl text-foreground leading-8 tracking-tight outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{thread.title}
					</h2>
					{lead ? (
						<div className="mt-4 flex items-center gap-3">
							<GalleryAvatar agent={lead} size={40} />
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-medium text-foreground text-sm">
									{agents.length > 1
										? tl("{name} and {moreCount} more", {
												moreCount: agents.length - 1,
												name: lead.name,
											})
										: lead.name}
								</span>
								<span className="truncate text-muted-foreground text-sm">
									{lead.description || "Agent"}
								</span>
							</div>
							<Button
								onClick={() => onMessage(lead.id)}
								radius="pill"
								size="sm"
								variant="secondary"
							>
								<MessageCirclePlus
									aria-hidden="true"
									data-icon="inline-start"
								/>
								Message
							</Button>
						</div>
					) : null}
					<div
						className={cn(
							"border-border border-t pt-5",
							lead ? "mt-5" : "mt-6"
						)}
					>
						<DetailFacts item={item} now={now} />
					</div>
					{related.length > 0 ? (
						<section aria-labelledby="gallery-related" className="mt-10">
							<h3
								className="font-semibold text-base text-foreground"
								id="gallery-related"
							>
								More like this
							</h3>
							<div
								className="mt-4 flex items-start"
								role="list"
								style={{ gap: SHELF_GAP }}
							>
								{shelf.map((column, columnIndex) => (
									<div
										className="flex min-w-0 flex-1 flex-col"
										key={`shelf-${columnIndex.toString()}`}
										role="none"
										style={{ gap: SHELF_GAP + 8 }}
									>
										{column.map((entry, index) => (
											<GalleryCard
												index={index * 2 + columnIndex}
												item={entry}
												key={entry.thread.id}
												now={now}
												onMessage={onMessage}
												onOpen={onOpen}
												reduceMotion={reduceMotion}
											/>
										))}
									</div>
								))}
							</div>
						</section>
					) : null}
				</div>
			</motion.aside>
			{conversation}
		</div>
	);
}
