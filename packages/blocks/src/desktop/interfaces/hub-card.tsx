import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronRight } from "lucide-react";
import { type ReactNode, type Ref, useId, useState } from "react";
import type { HubCard } from "./hub-model.ts";
import { HubThreadAvatar } from "./hub-parts.tsx";

/**
 * One glanceable card: a tonal surface with a small label, a large headline
 * that answers the card's question, and the few rows behind it. Every card
 * shares one height so the row reads as a set; rows sit at the top, the
 * footer at the bottom, and a long list scrolls inside once expanded.
 */
export function HubCardFrame({
	cardRef,
	children,
	className,
	footer,
	headline,
	id,
	index,
	label,
}: {
	cardRef?: Ref<HTMLElement>;
	children?: ReactNode;
	className?: string;
	footer?: ReactNode;
	headline?: ReactNode;
	id: HubCard;
	index: number;
	label: string;
}) {
	const titleId = useId();
	return (
		<section
			aria-labelledby={titleId}
			aria-roledescription="card"
			className={cn(
				"@container/hub-card flex h-(--hub-card-h) w-(--hub-card) shrink-0 snap-start scroll-ml-(--hub-gutter) flex-col rounded-[28px] bg-card px-6 pt-6 pb-4 text-card-foreground outline-none ring-1 ring-border/60 focus-visible:ring-2 focus-visible:ring-ring",
				className
			)}
			data-card={id}
			data-index={index}
			ref={cardRef}
			tabIndex={-1}
		>
			<h2
				className="font-medium text-muted-foreground text-sm leading-5"
				id={titleId}
			>
				{label}
			</h2>
			{headline ? (
				<p className="mt-1 text-balance text-[28px] text-foreground leading-9 tracking-[-0.01em]">
					{headline}
				</p>
			) : null}
			{children ? (
				<div className="-mx-3 mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-3 [scrollbar-width:thin]">
					{children}
				</div>
			) : null}
			{footer ? <div className="mt-auto shrink-0">{footer}</div> : null}
		</section>
	);
}

/**
 * The first rows of a list, plus a "Show all" toggle when more are hidden.
 * Expanding grows the card up to its cap; the list then scrolls in place.
 */
export function useHubRows<T>(
	items: T[],
	limit: number
): { footer: ReactNode; shown: T[] } {
	const [expanded, setExpanded] = useState(false);
	const hidden = items.length - limit;
	if (hidden <= 0) {
		return { footer: null, shown: items };
	}
	return {
		footer: (
			<HubShowAll
				count={items.length}
				expanded={expanded}
				onToggle={() => setExpanded((value) => !value)}
			/>
		),
		shown: expanded ? items : items.slice(0, limit),
	};
}

function HubShowAll({
	count,
	expanded,
	onToggle,
}: {
	count: number;
	expanded: boolean;
	onToggle: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex pt-2">
			<button
				aria-expanded={expanded}
				className="inline-flex h-10 items-center rounded-full bg-secondary px-4 font-medium text-secondary-foreground text-sm outline-none transition-colors duration-150 hover:bg-secondary/70 focus-visible:ring-3 focus-visible:ring-ring/40 active:bg-muted"
				onClick={onToggle}
				type="button"
			>
				{expanded ? "Show fewer" : tl("Show all {count}", { count })}
			</button>
		</div>
	);
}

/** A card's calm empty state: the headline states the fact, this the why. */
export function HubCardEmpty({ detail }: { detail: string }) {
	return (
		<p className="pt-1 pb-2 text-muted-foreground text-sm leading-5">
			{detail}
		</p>
	);
}

/**
 * A thread row: the lead agent's face, the title, and one line of who and
 * when. The whole row is the touch target; `trailing` is decorative.
 */
export function HubThreadRow({
	agents,
	children,
	label,
	meta,
	onOpen,
	title,
	trailing,
}: {
	agents: InterfaceAgent[];
	children?: ReactNode;
	label: string;
	meta: ReactNode;
	onOpen: () => void;
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<li>
			<button
				aria-label={label}
				className="-mx-3 flex w-[calc(100%+1.5rem)] items-start gap-4 rounded-2xl px-3 py-3.5 text-left outline-none transition-colors duration-150 hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-inset active:bg-muted"
				onClick={onOpen}
				type="button"
			>
				<HubThreadAvatar agents={agents} />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium text-[17px] text-foreground leading-6">
						{title}
					</span>
					<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm leading-5">
						{meta}
					</span>
					{children}
				</span>
				{trailing}
			</button>
		</li>
	);
}

/**
 * Visible action inside a row (the row itself is the button): a tonal pill
 * with the verb, or a chevron when the card is too narrow for the pill.
 */
export function HubOpenPill({ label = "Open" }: { label?: string }) {
	return (
		<>
			<span
				aria-hidden="true"
				className="@[22rem]/hub-card:inline-flex hidden h-8 shrink-0 items-center self-center rounded-full bg-secondary px-4 font-medium text-secondary-foreground text-sm"
			>
				{label}
			</span>
			<ChevronRight
				aria-hidden="true"
				className="@[22rem]/hub-card:hidden size-5 shrink-0 self-center text-muted-foreground"
			/>
		</>
	);
}

/** Placeholder card while the host's first snapshot loads. */
export function HubSkeletonCard({ index }: { index: number }) {
	return (
		<div
			aria-hidden="true"
			className="flex h-(--hub-card-h) w-(--hub-card) shrink-0 flex-col overflow-hidden rounded-[28px] bg-card px-6 pt-6 pb-7 ring-1 ring-border/60"
			data-index={index}
		>
			<Skeleton className="my-0.5 h-4 w-28" radius="pill" />
			<Skeleton className="mt-3 h-7 w-52" radius="pill" />
			<div className="mt-6 flex flex-col gap-7">
				{[0, 1, 2].map((row) => (
					<div className="flex items-center gap-4" key={row}>
						<Skeleton className="size-11 shrink-0" radius="pill" />
						<div className="flex flex-1 flex-col gap-2">
							<Skeleton className="h-4 w-4/5" radius="pill" />
							<Skeleton className="h-3 w-1/2" radius="pill" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
