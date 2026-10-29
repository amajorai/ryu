import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { Plus, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	rowWhen,
	stageStep,
	TRACKING_STAGE_LABELS,
	TRACKING_STEPS,
	TRACKING_TABS,
	type TrackingParcel,
	type TrackingStage,
	type TrackingTab,
} from "./tracking-model.ts";

/** Text color for a stage label: only exceptions and deliveries stand out. */
export const STAGE_TEXT: Record<TrackingStage, string> = {
	awaiting: "text-muted-foreground",
	delivered: "text-status-success",
	exception: "text-status-destructive",
	label: "text-muted-foreground",
	out: "text-foreground",
	transit: "text-foreground",
};

/** Five-segment progress meter, the same scale as the stepper. */
export function TrackingMeter({
	className,
	stage,
}: {
	className?: string;
	stage: TrackingStage;
}) {
	const reached =
		stage === "delivered" ? TRACKING_STEPS.length : stageStep(stage);
	return (
		<span
			aria-hidden="true"
			className={cn("flex w-14 shrink-0 gap-0.5", className)}
		>
			{TRACKING_STEPS.map((step, index) => {
				const isCurrent = index === reached && stage !== "delivered";
				return (
					<span
						className={cn(
							"h-1 flex-1 rounded-full bg-border",
							index < reached && "bg-foreground/70",
							stage === "delivered" && "bg-status-success",
							isCurrent && stage === "exception" && "bg-destructive",
							isCurrent &&
								(stage === "transit" || stage === "out") &&
								"bg-primary"
						)}
						key={step}
					/>
				);
			})}
		</span>
	);
}

function TrackingRow({
	events,
	now,
	onSelect,
	parcel,
	selected,
}: {
	events: readonly InterfaceEvent[];
	now: number;
	onSelect: (threadId: string) => void;
	parcel: TrackingParcel;
	selected: boolean;
}) {
	const title = parcel.thread.title.trim() || "Untitled conversation";
	const courier = parcel.courier;
	return (
		<li>
			<button
				aria-current={selected ? "true" : undefined}
				className={cn(
					"group relative flex w-full flex-col gap-1 px-4 py-3 text-left outline-none transition-colors",
					"hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					selected && "bg-muted/60 hover:bg-muted/60"
				)}
				data-thread-id={parcel.thread.id}
				data-tracking-row=""
				onClick={() => onSelect(parcel.thread.id)}
				type="button"
			>
				<span className="flex items-center gap-3">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-xs",
							STAGE_TEXT[parcel.stage]
						)}
					>
						{parcel.stage === "exception"
							? "Exception"
							: TRACKING_STAGE_LABELS[parcel.stage]}
					</span>
					<TrackingMeter stage={parcel.stage} />
				</span>
				<span className="flex items-baseline gap-3">
					<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
						{title}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{rowWhen(parcel, now, events)}
					</span>
				</span>
				<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
					<span className="flex min-w-0 items-center gap-1.5">
						{courier ? (
							<BoardAvatar agent={courier} name={courier.name} size={20} />
						) : null}
						<span className="truncate">
							{courier
								? `${courier.name}${parcel.agents.length > 1 ? ` +${parcel.agents.length - 1}` : ""}`
								: "No courier"}
						</span>
					</span>
					<span aria-hidden="true">·</span>
					<span className="shrink-0 font-mono text-[11px] tracking-wide">
						{parcel.number}
					</span>
				</span>
			</button>
		</li>
	);
}

/** Up/Down/Home/End move between rows (and select them, like a mail list). */
function onListKeyDown(
	event: KeyboardEvent<HTMLUListElement>,
	onSelect: (threadId: string) => void
) {
	const rows = [
		...event.currentTarget.querySelectorAll<HTMLButtonElement>(
			"[data-tracking-row]"
		),
	];
	const active = document.activeElement;
	const index = active instanceof HTMLButtonElement ? rows.indexOf(active) : -1;
	let next = -1;
	if (event.key === "ArrowDown") {
		next = Math.min(rows.length - 1, index + 1);
	} else if (event.key === "ArrowUp") {
		next = Math.max(0, index - 1);
	} else if (event.key === "Home") {
		next = 0;
	} else if (event.key === "End") {
		next = rows.length - 1;
	}
	const row = rows[next];
	if (next < 0 || !row) {
		return;
	}
	event.preventDefault();
	row.focus();
	const threadId = row.dataset.threadId;
	if (threadId) {
		onSelect(threadId);
	}
}

function TrackingTabs({
	compact,
	counts,
	idPrefix,
	onChange,
	tab,
}: {
	/** Tighter spacing for the narrower list column. */
	compact: boolean;
	counts: Record<TrackingTab, number>;
	/** Unique per mount, so two renderers on a page never share ids. */
	idPrefix: string;
	onChange: (tab: TrackingTab) => void;
	tab: TrackingTab;
}) {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = TRACKING_TABS.findIndex((item) => item.id === tab);
		let next = index;
		if (event.key === "ArrowRight") {
			next = (index + 1) % TRACKING_TABS.length;
		} else if (event.key === "ArrowLeft") {
			next = (index - 1 + TRACKING_TABS.length) % TRACKING_TABS.length;
		} else {
			return;
		}
		event.preventDefault();
		const target = TRACKING_TABS[next];
		if (target) {
			onChange(target.id);
			refs.current[next]?.focus();
		}
	};
	return (
		<div
			aria-label="Deliveries"
			className={cn(
				"flex shrink-0 overflow-x-auto px-4 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]",
				compact ? "gap-3" : "gap-4"
			)}
			onKeyDown={onKeyDown}
			role="tablist"
		>
			{TRACKING_TABS.map((item, index) => {
				const active = item.id === tab;
				return (
					<button
						aria-controls={`${idPrefix}-panel`}
						aria-selected={active}
						className={cn(
							"group relative flex h-10 shrink-0 items-center whitespace-nowrap font-medium text-sm outline-none transition-colors",
							active
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						id={`${idPrefix}-tab-${item.id}`}
						key={item.id}
						onClick={() => onChange(item.id)}
						ref={(element) => {
							refs.current[index] = element;
						}}
						role="tab"
						tabIndex={active ? 0 : -1}
						type="button"
					>
						<span className="-mx-1 flex h-6 items-center gap-1 rounded-sm px-1 group-focus-visible:ring-2 group-focus-visible:ring-ring/50">
							{item.label}
							<span
								className={cn(
									"text-xs tabular-nums",
									item.id === "exceptions" && counts.exceptions > 0
										? "text-status-destructive"
										: "text-muted-foreground"
								)}
							>
								{counts[item.id]}
							</span>
						</span>
						{active ? (
							<span
								aria-hidden="true"
								className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground"
							/>
						) : null}
					</button>
				);
			})}
		</div>
	);
}

const EMPTY_TAB: Record<TrackingTab, string> = {
	all: "No deliveries match.",
	delivered: "Nothing delivered yet. Replies from agents land here.",
	exceptions: "No exceptions. Every run finished cleanly.",
	"on-the-way": "Nothing on the way. Send a parcel to start one.",
};

/** The first tab, in tab order, that holds a search match. */
function tabWithMatches(
	counts: Record<TrackingTab, number>
): (typeof TRACKING_TABS)[number] | undefined {
	return TRACKING_TABS.find((item) => item.id !== "all" && counts[item.id] > 0);
}

function NoMatches({
	counts,
	onTabChange,
	query,
	tab,
}: {
	counts: Record<TrackingTab, number>;
	onTabChange: (tab: TrackingTab) => void;
	query: string;
	tab: TrackingTab;
}) {
	const tl = useLiteralMessages();
	const label = TRACKING_TABS.find((item) => item.id === tab)?.label ?? "";
	const elsewhere = tab === "all" ? undefined : tabWithMatches(counts);
	return (
		<div className="flex flex-col items-start gap-3 px-4 py-8">
			<p className="text-muted-foreground text-sm">
				{tab === "all" || counts.all === 0
					? tl("No deliveries match “{query}”.", { query })
					: tl("Nothing in {tabLabel} matches “{query}”.", {
							query,
							tabLabel: label,
						})}
			</p>
			{elsewhere ? (
				<Button
					onClick={() => onTabChange(elsewhere.id)}
					size="sm"
					type="button"
					variant="outline"
				>
					{tl("Show {count} in {tabLabel}", {
						count: String(counts[elsewhere.id]),
						tabLabel: elsewhere.label,
					})}
				</Button>
			) : null}
		</div>
	);
}

const SKELETON_ROWS = ["one", "two", "three", "four", "five", "six"] as const;

export function TrackingListSkeleton() {
	return (
		<ul aria-hidden="true" className="flex flex-col">
			{SKELETON_ROWS.map((key) => (
				<li className="flex flex-col gap-2 px-4 py-3.5" key={key}>
					<Skeleton className="h-3 w-24" radius="dense" />
					<Skeleton className="h-3.5 w-56" radius="dense" />
					<Skeleton className="h-3 w-40" radius="dense" />
				</li>
			))}
		</ul>
	);
}

export function TrackingList({
	canSend,
	compact = false,
	counts,
	events,
	loading,
	now,
	onQueryChange,
	onSelect,
	onSend,
	onTabChange,
	parcels,
	query,
	selectedId,
	tab,
}: {
	canSend: boolean;
	/** Set when the list column is at its narrower width. */
	compact?: boolean;
	counts: Record<TrackingTab, number>;
	events: readonly InterfaceEvent[];
	loading: boolean;
	now: number;
	onQueryChange: (query: string) => void;
	onSelect: (threadId: string) => void;
	onSend: () => void;
	onTabChange: (tab: TrackingTab) => void;
	parcels: TrackingParcel[];
	query: string;
	selectedId: string | null;
	tab: TrackingTab;
}) {
	const searchId = useId();
	const headingId = useId();
	const tabsId = useId();
	const tl = useLiteralMessages();
	let body: ReactNode;
	if (loading) {
		body = <TrackingListSkeleton />;
	} else if (parcels.length === 0) {
		body = query.trim() ? (
			<NoMatches
				counts={counts}
				onTabChange={onTabChange}
				query={query.trim()}
				tab={tab}
			/>
		) : (
			<p className="px-4 py-8 text-muted-foreground text-sm">
				{EMPTY_TAB[tab]}
			</p>
		);
	} else {
		body = (
			<ul
				aria-label={tl("{tabLabel} deliveries", {
					tabLabel:
						TRACKING_TABS.find((item) => item.id === tab)?.label ?? "All",
				})}
				className="flex flex-col divide-y divide-border/60"
				onKeyDown={(event) => onListKeyDown(event, onSelect)}
			>
				{parcels.map((parcel) => (
					<TrackingRow
						events={events}
						key={parcel.thread.id}
						now={now}
						onSelect={onSelect}
						parcel={parcel}
						selected={parcel.thread.id === selectedId}
					/>
				))}
			</ul>
		);
	}
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-0 flex-1 flex-col border-border bg-background"
		>
			<header className="flex h-14 shrink-0 items-center gap-2 px-4">
				<h2
					className="min-w-0 flex-1 truncate font-semibold text-base text-foreground"
					id={headingId}
				>
					My deliveries
				</h2>
				<Button
					disabled={!canSend}
					onClick={onSend}
					size="sm"
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					Send a parcel
				</Button>
			</header>
			<div className="px-4 pb-3" role="search">
				<label className="sr-only" htmlFor={searchId}>
					Track a parcel
				</label>
				<InputGroup className="h-9 rounded-lg border-border bg-muted/40 has-[[data-slot=input-group-control]:focus-visible]:bg-background">
					<InputGroupAddon>
						<Search aria-hidden="true" className="size-4" />
					</InputGroupAddon>
					<InputGroupInput
						autoComplete="off"
						className="text-sm"
						id={searchId}
						inputMode="search"
						onChange={(event) => onQueryChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.preventDefault();
								onQueryChange("");
							}
						}}
						placeholder="Tracking number, item or courier"
						spellCheck={false}
						type="text"
						value={query}
					/>
					{query ? (
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								aria-label="Clear search"
								className="text-muted-foreground"
								onClick={() => onQueryChange("")}
								size="icon-xs"
								title="Clear search"
							>
								<X aria-hidden="true" />
							</InputGroupButton>
						</InputGroupAddon>
					) : null}
				</InputGroup>
			</div>
			<TrackingTabs
				compact={compact}
				counts={counts}
				idPrefix={tabsId}
				onChange={onTabChange}
				tab={tab}
			/>
			<div
				aria-busy={loading || undefined}
				aria-labelledby={`${tabsId}-tab-${tab}`}
				className="min-h-0 flex-1 overflow-y-auto"
				id={`${tabsId}-panel`}
				role="tabpanel"
			>
				{body}
			</div>
		</section>
	);
}
