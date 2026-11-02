import { translate as tr } from "@ryu/i18n/lite";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { type ReactNode, type Ref, useContext } from "react";
import { relativeAge } from "./interface-renderer.ts";
import {
	aisleLabel,
	STAGE_MEANING,
	STAGE_PIPELINE,
	stageLabel,
	type WarehouseOrder,
} from "./warehouse-model.ts";
import {
	Fulfiller,
	StagePill,
	WarehouseActsContext,
} from "./warehouse-parts.tsx";

export { CreateOrder } from "./warehouse-order-create.tsx";

export function PanelHeader({
	backLabel,
	children,
	headingRef,
	onBack,
	trailing,
}: {
	backLabel: string;
	children: ReactNode;
	headingRef: Ref<HTMLHeadingElement>;
	onBack: () => void;
	trailing?: ReactNode;
}) {
	return (
		<header className="flex h-14 shrink-0 items-center gap-2 border-border border-b ps-2 pe-4">
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-keyshortcuts="Escape"
							aria-label={backLabel}
							onClick={onBack}
							size="icon-sm"
							type="button"
							variant="ghost"
						/>
					}
				>
					<ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
				</TooltipTrigger>
				<TooltipContent className="flex items-center gap-2" side="bottom">
					{backLabel}
					<Kbd>Esc</Kbd>
				</TooltipContent>
			</Tooltip>
			<h2
				className="flex min-w-0 items-center gap-2 font-semibold text-foreground text-sm outline-none"
				ref={headingRef}
				tabIndex={-1}
			>
				{children}
			</h2>
			<div className="ms-auto flex shrink-0 items-center gap-2">{trailing}</div>
		</header>
	);
}

/**
 * Received → Shipped, with the order's place marked. A failed run stopped
 * while the agent was picking: that step turns destructive and the steps
 * after it stay plain.
 */
function Progress({ order }: { order: WarehouseOrder }) {
	const acts = useContext(WarehouseActsContext);
	// A stopped, old-failed or parked run halted at picking.
	const halt: Partial<Record<WarehouseOrder["stage"], string>> = {
		exception: "failed",
		parked: "parked",
		stale: "old failure",
	};
	const haltedAs = halt[order.stage];
	const failed = order.stage === "exception";
	const reached = haltedAs ? 1 : STAGE_PIPELINE.indexOf(order.stage);
	return (
		<ol
			aria-label="Fulfillment progress"
			className="grid grid-cols-5 items-start gap-1.5"
		>
			{STAGE_PIPELINE.map((stage, index) => {
				const done = index < reached || (!failed && index === reached);
				const current = index === reached;
				return (
					<li
						aria-current={current ? "step" : undefined}
						className="flex min-w-0 flex-col gap-1.5"
						key={stage}
					>
						<span
							className={cn(
								"h-1 rounded-full",
								current && failed
									? "bg-destructive"
									: done
										? "bg-foreground"
										: "bg-muted"
							)}
						/>
						<span
							className={cn(
								"truncate text-xs",
								current
									? failed
										? "font-medium text-status-destructive"
										: "font-medium text-foreground"
									: "text-muted-foreground"
							)}
						>
							{current && haltedAs
								? `${stageLabel(stage, acts)} · ${haltedAs}`
								: stageLabel(stage, acts)}
						</span>
					</li>
				);
			})}
		</ol>
	);
}

function DetailRow({
	label,
	children,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="grid h-9 grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
			<dt className="text-muted-foreground text-sm leading-5">{label}</dt>
			<dd className="flex min-w-0 items-center text-foreground text-sm leading-5">
				{children}
			</dd>
		</div>
	);
}

/**
 * One order, the way an order page reads: its number and stage, the items
 * (the conversation's title), where it is in fulfillment, the latest note,
 * and who is fulfilling it. "Fulfil" opens the conversation itself.
 */
export function OrderDetail({
	agents,
	headingRef,
	now,
	onBack,
	onFulfil,
	order,
}: {
	agents: readonly InterfaceAgent[];
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onBack: () => void;
	onFulfil: () => void;
	order: WarehouseOrder;
}) {
	const acts = useContext(WarehouseActsContext);
	const tl = useLiteralMessages();
	const { thread } = order;
	const noteAuthor =
		thread.lastMessageRole === "user"
			? "You"
			: (order.agent?.name ?? tr("Agent"));
	const earlier = Math.max(
		0,
		thread.messageCount - (thread.lastMessage ? 1 : 0)
	);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader
				backLabel="Back to orders"
				headingRef={headingRef}
				onBack={onBack}
				trailing={
					<Button onClick={onFulfil} size="sm" type="button">
						<MessageSquare aria-hidden="true" data-icon="inline-start" />
						Fulfil
					</Button>
				}
			>
				<span className="tabular-nums">{order.number}</span>
				<StagePill stage={order.stage} />
			</PanelHeader>
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-5">
				<section
					aria-labelledby={`${order.id}-items`}
					className="flex flex-col gap-1"
				>
					<h3
						className="text-pretty font-semibold text-base text-foreground leading-6"
						data-ryu-i18n="off"
						id={`${order.id}-items`}
					>
						{thread.title}
					</h3>
					<p className="text-muted-foreground text-sm">
						{STAGE_MEANING[order.stage]}
					</p>
				</section>
				<Progress order={order} />
				<dl className="flex flex-col divide-y divide-border border-border border-y">
					<DetailRow label="Customer">You</DetailRow>
					<DetailRow label="Fulfiller">
						<Fulfiller agent={order.agent} />
					</DetailRow>
					{/* The floor shows no aisle letters under acts. */}
					{order.agent && !acts ? (
						<DetailRow label="Location">
							{aisleLabel(order.agent.id, agents)}
						</DetailRow>
					) : null}
					{acts ? null : (
						<DetailRow label="Updated">
							<span className="tabular-nums">
								{updatedAgo(thread.updatedAt, now)}
							</span>
						</DetailRow>
					)}
				</dl>
				<section
					aria-labelledby={`${order.id}-timeline`}
					className="flex flex-col gap-3"
				>
					<h3
						className="font-medium text-foreground text-sm"
						id={`${order.id}-timeline`}
					>
						Timeline
					</h3>
					{thread.lastMessage ? (
						<figure className="flex flex-col gap-1">
							<figcaption className="flex items-baseline gap-2 text-xs">
								<span className="font-medium text-foreground">
									{noteAuthor}
								</span>
								{acts ? null : (
									<span className="text-muted-foreground tabular-nums">
										{updatedAgo(thread.updatedAt, now)}
									</span>
								)}
							</figcaption>
							<blockquote
								className="line-clamp-4 text-pretty text-foreground text-sm leading-relaxed"
								data-ryu-i18n="off"
							>
								{thread.lastMessage}
							</blockquote>
						</figure>
					) : (
						<p className="text-muted-foreground text-sm">No messages yet.</p>
					)}
					<Button
						className="w-full"
						onClick={onFulfil}
						size="sm"
						type="button"
						variant="outline"
					>
						{earlier > 0
							? tl(
									"Show {count, plural, one {{countText} earlier message} other {{countText} earlier messages}}",
									{ count: earlier, countText: String(earlier) }
								)
							: "Open conversation"}
					</Button>
				</section>
			</div>
		</div>
	);
}

/** How fresh an order is; nothing under the act layer (never `updatedAt`, spec 5.2). */
function updatedAgo(updatedAt: string, now: number): string {
	return relativeAge(updatedAt, now);
}

/**
 * The order's summary kept beside its conversation, the way an order page
 * keeps it next to the timeline: who fulfils it, where, and how fresh.
 */
function OrderFacts({
	agents,
	now,
	order,
}: {
	agents: readonly InterfaceAgent[];
	now: number;
	order: WarehouseOrder;
}) {
	const acts = useContext(WarehouseActsContext);
	const location = order.agent ? aisleLabel(order.agent.id, agents) : null;
	const cell = "flex min-w-0 flex-col justify-center gap-1 px-4 py-3 lg:py-0";
	const term = "truncate text-muted-foreground text-xs";
	const value = "flex min-w-0 truncate font-medium text-foreground text-sm";
	return (
		// Laid out like the floor's stats strip (and the same height), so the
		// two columns share their rules while the conversation is open.
		<dl
			aria-label="Order summary"
			className="grid shrink-0 grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] divide-x divide-border border-border border-b max-sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:h-19"
		>
			<div className={cell}>
				<dt className={term}>Fulfiller</dt>
				<dd className={value}>
					<Fulfiller
						agent={order.agent}
						className="font-medium text-sm"
						size={16}
					/>
				</dd>
			</div>
			<div className={cell}>
				{/* No aisle letters on the floor under acts: the stage instead. */}
				<dt className={term}>{acts ? "Stage" : "Location"}</dt>
				<dd className={value}>
					{acts
						? stageLabel(order.stage, acts)
						: (location ?? tr("Unassigned"))}
				</dd>
			</div>
			<div className={cn(cell, "max-sm:hidden")}>
				<dt className={term}>Messages</dt>
				<dd className={cn(value, "tabular-nums")}>
					{order.thread.messageCount}
				</dd>
			</div>
			{acts ? null : (
				<div className={cn(cell, "max-sm:hidden")}>
					<dt className={term}>Updated</dt>
					<dd className={cn(value, "tabular-nums")}>
						{updatedAgo(order.thread.updatedAt, now)}
					</dd>
				</div>
			)}
		</dl>
	);
}

/** The open order: a slim order header over the host's own conversation. */
export function OrderConversation({
	agents,
	headingRef,
	now,
	onBack,
	order,
	threadView,
}: {
	agents: readonly InterfaceAgent[];
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	onBack: () => void;
	order: WarehouseOrder | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const backLabel = order
		? tl("Back to order {number}", { number: order.number })
		: "Back to orders";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader
				backLabel={backLabel}
				headingRef={headingRef}
				onBack={onBack}
			>
				{order ? (
					<>
						<span className="shrink-0 tabular-nums">{order.number}</span>
						<span
							className="truncate font-normal text-muted-foreground"
							data-ryu-i18n="off"
						>
							{order.thread.title}
						</span>
						<StagePill className="max-sm:hidden" stage={order.stage} />
					</>
				) : (
					"New order"
				)}
			</PanelHeader>
			{order ? <OrderFacts agents={agents} now={now} order={order} /> : null}
			<div
				className="flex min-h-0 flex-1 flex-col"
				data-testid="warehouse-thread"
			>
				{threadView}
			</div>
		</div>
	);
}
