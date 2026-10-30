import { useLiteralMessages } from "@ryu/i18n/react";
import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef, useState } from "react";

const PREVIEW_TITLE_LENGTH = 56;

const PREVIEW_DESCRIPTION_LENGTH = 88;

export const RAIL_COLLAPSE_ITEM_COUNT = 18;

function truncateMessageText(text: string, limit: number) {
	if (text.length <= limit) {
		return text;
	}
	const excerpt = text.slice(0, limit);
	const boundary = excerpt.lastIndexOf(" ");
	return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

function getMessageText(message: HTMLElement) {
	const surface =
		message.querySelector<HTMLElement>(
			'[data-slot="message-bubble-content"]'
		) ??
		message.querySelector<HTMLElement>('[data-slot="message-content"]') ??
		message;
	return (surface.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function getMessagePreview(
	message: HTMLElement,
	assistantResponse?: HTMLElement
) {
	const text = getMessageText(message);
	if (!text) {
		return { label: "Message", description: undefined };
	}

	if (text.length <= PREVIEW_TITLE_LENGTH) {
		const responseText = assistantResponse
			? getMessageText(assistantResponse)
			: "";
		return {
			label: text,
			description: responseText
				? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
				: undefined,
		};
	}

	const titleExcerpt = text.slice(0, PREVIEW_TITLE_LENGTH);
	const titleBoundary = titleExcerpt.lastIndexOf(" ");
	const titleEnd =
		titleBoundary > PREVIEW_TITLE_LENGTH * 0.65
			? titleBoundary
			: PREVIEW_TITLE_LENGTH;
	const label = `${text.slice(0, titleEnd).trim()}…`;
	const responseText = assistantResponse
		? getMessageText(assistantResponse)
		: text.slice(titleEnd).trim();
	return {
		label,
		description: responseText
			? truncateMessageText(responseText, PREVIEW_DESCRIPTION_LENGTH)
			: undefined,
	};
}

export function CollapsedMessageRail({
	items,
	activeId,
	onItemSelect,
}: {
	items: PreviewRailItem[];
	activeId: string;
	onItemSelect: (item: PreviewRailItem) => void;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const messageListRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const revealActiveItem = () => {
			const list = messageListRef.current;
			const activeItem = list?.querySelector<HTMLElement>(
				'[data-active="true"]'
			);
			if (!(list && activeItem)) {
				return;
			}
			list.scrollTop = Math.max(
				0,
				activeItem.offsetTop - (list.clientHeight - activeItem.offsetHeight) / 2
			);
		};
		const frame = window.requestAnimationFrame(revealActiveItem);
		const timer = window.setTimeout(revealActiveItem, 80);
		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(timer);
		};
	}, [activeId, open]);

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				aria-label={tl("Browse {count} messages", {
					count: String(items.length),
				})}
				className="absolute top-1/2 left-1 z-20 flex h-[5.5rem] w-7 -translate-y-1/2 flex-col items-center justify-center gap-1.5 rounded-full border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				data-active-message-id={activeId}
				data-count={items.length}
				data-slot="message-navigation-collapsed-rail"
				title={tl("Browse {count} messages", { count: String(items.length) })}
			>
				<span aria-hidden="true" className="flex flex-col items-center gap-1">
					<span className="h-px w-3 rounded-full bg-current/45" />
					<span className="h-px w-4 rounded-full bg-current/70" />
					<span className="h-px w-2.5 rounded-full bg-current/45" />
					<span className="h-px w-3.5 rounded-full bg-current/70" />
					<span className="h-px w-2 rounded-full bg-current/45" />
				</span>
				<span className="font-medium text-xs tabular-nums leading-none">
					{items.length > 99 ? "99+" : items.length}
				</span>
			</PopoverTrigger>
			<PopoverContent
				align="center"
				className="w-[min(22rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
				data-message-navigation-popover="true"
				side="right"
				sideOffset={10}
			>
				<div className="flex items-center justify-between border-border border-b px-3 py-2.5">
					<div className="min-w-0">
						<p className="font-medium text-sm">Messages</p>
						<p className="text-muted-foreground text-xs">
							Jump to any message in this conversation
						</p>
					</div>
					<span className="shrink-0 rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground text-xs tabular-nums">
						{items.length}
					</span>
				</div>
				<ul
					aria-label="All messages"
					className="scroll-fade max-h-[min(70vh,32rem)] overflow-y-auto p-1"
					data-slot="message-navigation-list"
					ref={messageListRef}
				>
					{items.map((item, index) => {
						const active = item.id === activeId;
						return (
							<li key={item.id}>
								<button
									aria-current={active ? "true" : undefined}
									className={cn(
										"flex w-full items-start gap-2 rounded-2xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
										active && "bg-muted/80"
									)}
									data-active={active ? "true" : undefined}
									data-message-id={item.id}
									data-slot="message-navigation-item"
									onClick={() => {
										onItemSelect(item);
										setOpen(false);
									}}
									type="button"
								>
									<span
										aria-hidden="true"
										className={cn(
											"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs tabular-nums",
											active && "bg-foreground text-background"
										)}
									>
										{index + 1}
									</span>
									<span className="min-w-0 flex-1">
										<span className="line-clamp-2 block font-medium text-xs leading-4">
											{item.label}
										</span>
										{item.description ? (
											<span className="mt-0.5 line-clamp-2 block text-muted-foreground text-xs leading-4">
												{item.description}
											</span>
										) : null}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
