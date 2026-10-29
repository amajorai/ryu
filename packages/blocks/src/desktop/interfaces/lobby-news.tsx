import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { KeyboardEvent } from "react";
import { compactAge } from "./interface-renderer.ts";
import { type NewsItem, STATUS_SQUAD_STATE } from "./lobby-model.ts";
import {
	SELECTED_RING,
	STAGE_BACKGROUND,
	STAGE_FLOOR,
	STAGE_RAYS,
} from "./lobby-palette.ts";
import {
	ChunkyButton,
	DISPLAY,
	KICKER,
	LobbyFigure,
	LobbyHead,
	STATUS_DOT,
} from "./lobby-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

function byline(item: NewsItem, now: number, acted: boolean): string {
	const who = item.agent?.name ?? "No agent";
	return acted ? who : `${who} · ${compactAge(item.thread.updatedAt, now)}`;
}

function agoLabel(iso: string, now: number): string {
	const age = compactAge(iso, now);
	if (!age) {
		return "";
	}
	return age === "now" ? "Just now" : `${age} ago`;
}

function isEditable(target: EventTarget): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [role='tab']") !== null)
	);
}

/**
 * NEWS tab: the latest updates as a carousel. One featured tile with the
 * thread's latest line and a READ button, over a strip of the other tiles.
 */
export function LobbyNews({
	acted = false,
	activeThreadId,
	index,
	items,
	loading,
	now,
	onIndex,
	onOpen,
}: {
	/**
	 * With the act layer, stories drop their legacy status words, dots and
	 * last-changed ages (which would contradict the acts).
	 */
	acted?: boolean;
	activeThreadId: string | null;
	index: number;
	items: NewsItem[];
	loading: boolean;
	now: number;
	onIndex: (index: number) => void;
	onOpen: (threadId: string) => void;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const count = items.length;
	const current = items[Math.min(index, count - 1)];
	const go = (step: number) => {
		if (count > 0) {
			onIndex((index + step + count) % count);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (isEditable(event.target)) {
			return;
		}
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			go(-1);
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			go(1);
		}
	};

	if (loading) {
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-6 px-8 py-8">
				<Skeleton className="h-10 w-40 rounded-none" />
				<Skeleton className="h-80 w-full rounded-none" />
				<div className="grid grid-cols-4 gap-3">
					{[0, 1, 2, 3].map((slot) => (
						<Skeleton className="h-20 rounded-none" key={slot} />
					))}
				</div>
			</div>
		);
	}

	return (
		<section
			aria-label="News"
			aria-roledescription="carousel"
			className="@container flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-8 max-sm:px-4 max-sm:py-4"
			onKeyDown={onKeyDown}
		>
			<header className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-6">
					<h2
						className={cn(
							DISPLAY,
							"pt-1 text-(--gk-ink) text-[40px] max-sm:text-[28px]"
						)}
					>
						News
					</h2>
					{count > 1 ? (
						<div className="flex items-center gap-2">
							<span className={cn(KICKER, "me-2 text-(--gk-ink) tabular-nums")}>
								{index + 1} / {count}
							</span>
							<ChunkyButton
								aria-label="Previous story"
								className="w-10 px-0"
								onClick={() => go(-1)}
								tone="secondary"
							>
								<ChevronLeft aria-hidden="true" className="size-4" />
							</ChunkyButton>
							<ChunkyButton
								aria-label="Next story"
								className="w-10 px-0"
								onClick={() => go(1)}
								tone="secondary"
							>
								<ChevronRight aria-hidden="true" className="size-4" />
							</ChunkyButton>
						</div>
					) : null}
				</div>
				<p className="text-(--gk-ink-muted) text-[13px]">
					The latest from every conversation, newest first.
				</p>
			</header>
			{current ? (
				<>
					<div
						aria-label={`${index + 1} of ${count}`}
						aria-live="polite"
						aria-roledescription="slide"
						className={cn(
							"relative grid @min-2xl:max-h-[520px] @min-2xl:min-h-[380px] @min-2xl:flex-1 shrink-0 @max-2xl:grid-cols-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)] overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-(--gk-plate) shadow-(--gk-lip)"
						)}
						role="group"
					>
						<AnimatePresence initial={false} mode="popLayout">
							<motion.div
								animate={{ opacity: 1 }}
								className="relative flex @max-2xl:h-56 items-end justify-center overflow-hidden @max-2xl:pb-6 pb-12"
								exit={{ opacity: 0 }}
								initial={{ opacity: reduceMotion ? 1 : 0 }}
								key={`art-${current.thread.id}`}
								style={{ background: STAGE_BACKGROUND }}
								transition={{ duration: reduceMotion ? 0 : 0.2 }}
							>
								<span
									aria-hidden="true"
									className="pointer-events-none absolute inset-0"
									style={STAGE_RAYS}
								/>
								<span
									aria-hidden="true"
									className="pointer-events-none absolute inset-x-0 -bottom-10 h-36"
									style={STAGE_FLOOR}
								/>
								{current.agent ? (
									<span className="relative @max-2xl:w-24 w-[min(36%,170px)]">
										<span
											aria-hidden="true"
											className="absolute -inset-x-[18%] -bottom-[5%] h-[11%]"
											style={SELECTED_RING}
										/>
										<LobbyFigure
											agent={current.agent}
											className="relative"
											state={STATUS_SQUAD_STATE[current.status]}
										/>
									</span>
								) : (
									<span
										className={cn(
											DISPLAY,
											"pb-16 text-(--gk-ink)/20 text-[56px]"
										)}
									>
										Ryu
									</span>
								)}
							</motion.div>
						</AnimatePresence>
						<div className="flex min-w-0 flex-col justify-end gap-4 @max-2xl:p-5 p-8">
							<p
								className={cn(
									KICKER,
									"flex items-center gap-2 text-(--gk-ink-muted)"
								)}
							>
								{acted ? null : (
									<>
										<span
											aria-hidden="true"
											className={cn(
												"size-2 shrink-0 rounded-full",
												STATUS_DOT[current.status]
											)}
										/>
										<span className="text-(--gk-ink)">
											{THREAD_STATUS_LABELS[current.status]}
										</span>
										<span aria-hidden="true">·</span>
									</>
								)}
								<span>{current.agent?.name ?? "No agent"}</span>
								{acted ? null : (
									<>
										<span aria-hidden="true">·</span>
										<span className="tabular-nums">
											{agoLabel(current.thread.updatedAt, now)}
										</span>
									</>
								)}
							</p>
							<h3
								className={cn(
									DISPLAY,
									"line-clamp-2 pe-2 @max-2xl:text-[32px] text-(--gk-ink) text-[44px] [line-height:0.95]"
								)}
							>
								{current.title}
							</h3>
							<p className="line-clamp-3 max-w-[60ch] text-(--gk-ink-muted) text-[15px] leading-6">
								{current.thread.lastMessage ?? "No messages yet."}
							</p>
							<div className="flex items-center gap-4 pt-2">
								<ChunkyButton
									aria-label={
										current.thread.id === activeThreadId
											? tl("Reading: {title}", { title: current.title })
											: tl("Read: {title}", { title: current.title })
									}
									onClick={() => onOpen(current.thread.id)}
									size="lg"
									tone="primary"
								>
									{current.thread.id === activeThreadId ? "Reading" : "Read"}
								</ChunkyButton>
								<span className="text-(--gk-ink-muted) text-[13px] tabular-nums">
									{current.thread.messageCount}{" "}
									{current.thread.messageCount === 1 ? "message" : "messages"}
								</span>
							</div>
						</div>
					</div>
					<ul
						aria-label="All stories"
						className="grid @max-3xl:grid-cols-2 grid-cols-4 gap-3"
					>
						{items.map((item, itemIndex) => {
							const active = itemIndex === index;
							const open = item.thread.id === activeThreadId;
							return (
								<li key={item.thread.id}>
									<button
										aria-current={active ? "true" : undefined}
										aria-label={
											open
												? tl("Story {number}: {title}, open now", {
														number: String(itemIndex + 1),
														title: item.title,
													})
												: tl("Story {number}: {title}", {
														number: String(itemIndex + 1),
														title: item.title,
													})
										}
										className={cn(
											"group/story relative flex h-full w-full flex-col gap-2 px-4 pt-4 pb-3 text-start outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset",
											"overflow-hidden rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) shadow-[0_3px_0_var(--gk-edge)]",
											active
												? "bg-(--gk-plate-sunk)"
												: "hover:bg-(--gk-plate-sunk)"
										)}
										data-open={open || undefined}
										onClick={() => onIndex(itemIndex)}
										type="button"
									>
										<span
											aria-hidden="true"
											className={cn(
												"absolute inset-x-0 top-0 h-[3px] transition-colors",
												active ? "bg-primary" : "bg-(--gk-plate-sunk)"
											)}
										/>
										<span className="flex items-center gap-2">
											{item.agent ? (
												<LobbyHead
													agent={item.agent}
													className="size-6"
													state={
														acted ? "ready" : STATUS_SQUAD_STATE[item.status]
													}
												/>
											) : null}
											<span className="min-w-0 truncate text-(--gk-ink-muted) text-[11px] tabular-nums leading-4">
												{byline(item, now, acted)}
											</span>
											{open ? (
												<span
													className={cn(
														KICKER,
														"ms-auto flex h-4 shrink-0 -skew-x-12 items-center bg-primary px-1.5 text-[10px] text-primary-foreground"
													)}
												>
													<span className="skew-x-12">Open</span>
												</span>
											) : acted ? null : (
												<span
													aria-hidden="true"
													className={cn(
														"ms-auto size-2 shrink-0 rounded-full",
														STATUS_DOT[item.status]
													)}
												/>
											)}
										</span>
										<span className="line-clamp-2 font-semibold text-(--gk-ink) text-[13px] leading-5">
											{item.title}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</>
			) : (
				<div className="flex flex-col items-start gap-1 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) px-5 py-6 shadow-[0_3px_0_var(--gk-edge)]">
					<h3 className="font-semibold! text-(--gk-ink) text-[15px]">
						No news yet
					</h3>
					<p className="text-(--gk-ink-muted) text-[13px]">
						Updates show up here as your agents reply and finish runs.
					</p>
				</div>
			)}
		</section>
	);
}
