import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Store } from "lucide-react";
import { type ReactNode, type Ref, useRef } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import {
	type MarketOrder,
	type MarketShop,
	orderRecipients,
	orderSections,
	orderTitle,
	plural,
	shopKindText,
	visitingFrom,
} from "./market-model.ts";
import { CORK_BOARD_STYLE } from "./market-palette.ts";
import {
	NewOrderSlot,
	OrderSlip,
	SectionHeading,
	slipNumber,
} from "./market-slip.tsx";

export type MarketPanelView =
	| { kind: "shop"; shop: MarketShop }
	| {
			kind: "thread";
			order: MarketOrder | undefined;
			shop: MarketShop | undefined;
	  };

/** Who an empty board's slips will come from, in a sentence. */
function emptyBoardText(shop: MarketShop, tl: LiteralMessage): string {
	const [firstKeeper, secondKeeper] = shop.agents.map((agent) => agent.name);
	if (firstKeeper === undefined) {
		return tl(
			"No orders yet. Conversations with this shop are pinned here as slips."
		);
	}
	if (secondKeeper === undefined) {
		return tl(
			"No orders yet. Conversations with {keeper} are pinned here as slips.",
			{ keeper: firstKeeper }
		);
	}
	if (shop.agents.length > 2) {
		return tl(
			"No orders yet. Conversations with {firstKeeper}, {secondKeeper} and others are pinned here as slips.",
			{ firstKeeper, secondKeeper }
		);
	}
	return tl(
		"No orders yet. Conversations with {firstKeeper} and {secondKeeper} are pinned here as slips.",
		{ firstKeeper, secondKeeper }
	);
}

/** What waits on you at a shop, for its sheet's subtitle. */
function subtitleNeed(
	shop: MarketShop,
	acts: MarketPanelActs | undefined
): string {
	if (acts) {
		const count = acts.needYou(shop.id);
		return count > 0 ? ` · ${count} need you` : "";
	}
	return shop.waitingOnYou > 0 ? ` · ${shop.waitingOnYou} waiting on you` : "";
}

/** The shop's cork order board: every conversation as a slip, by need. */
function OrderBoard({
	acts,
	activeThreadId,
	now,
	onCloseOrder,
	onNewOrder,
	onServe,
	reduceMotion,
	shop,
	snapshot,
}: {
	/** With acts, each thread's section from the acts (`actOrderStatuses`). */
	acts?: ReadonlyMap<string, ThreadStatus>;
	activeThreadId: string | null;
	now: number;
	onCloseOrder: () => void;
	onNewOrder: () => void;
	onServe: (threadId: string) => void;
	reduceMotion: boolean;
	shop: MarketShop;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const sections = orderSections(
		acts
			? shop.orders.map((order) => ({
					...order,
					// A thread the acts say nothing about waits on no one.
					status: acts.get(order.thread.id) ?? "quiet",
				}))
			: shop.orders
	);
	return (
		<section
			aria-label="Order board"
			className="mx-3 mb-3 rounded-xl px-3 pt-3 pb-5"
			data-testid="market-board"
			style={CORK_BOARD_STYLE}
		>
			{sections.length === 0 ? (
				<div data-testid="market-empty-board">
					<NewOrderSlot
						description={emptyBoardText(shop, tl)}
						onOpen={onNewOrder}
					/>
				</div>
			) : (
				sections.map((section) => (
					<section
						aria-label={`${THREAD_STATUS_LABELS[section.status]}, ${plural(section.orders.length, "order")}`}
						className="mt-5 first:mt-0"
						key={section.status}
					>
						<SectionHeading
							count={section.orders.length}
							status={section.status}
						/>
						<ul className="mt-2 flex flex-col gap-4">
							{section.orders.map((order) => (
								<li key={order.thread.id}>
									<OrderSlip
										active={order.thread.id === activeThreadId}
										hideAge={acts !== undefined}
										homeName={visitingFrom(order, shop, snapshot)}
										now={now}
										onClose={onCloseOrder}
										onServe={onServe}
										order={order}
										still={reduceMotion}
									/>
								</li>
							))}
						</ul>
					</section>
				))
			)}
		</section>
	);
}

/**
 * The Market's sheet. A shop's sheet lists its shopkeepers (each starts an
 * order with them), its cork order board and the order composer; an order
 * being served is the host's own conversation, headed by its slip, with a
 * way back to the shop it came from.
 */
/** The act layer's view of the sheet: counts and keeper states from the acts. */
export interface MarketPanelActs {
	/** Whether one of the shop's keepers is working. */
	busy: (shopId: string) => boolean;
	/** A keeper's act: whether it works, and its state in words. */
	keeper: (agentId: string) => { words: string; working: boolean };
	/** The shop's blocking asks (its keepers'). */
	needYou: (shopId: string) => number;
	/** The shop's door sign from its keepers' acts (`shopSign`). */
	sign: (shopId: string) => string;
	/** Each thread's board section from the acts (`actOrderStatuses`). */
	statuses: ReadonlyMap<string, ThreadStatus>;
}

/** The door sign's dot: from the sign when the acts set it. */
const SIGN_DOT: Record<string, string> = {
	Busy: "bg-(--gk-warn)",
	"Closed for now": "bg-(--gk-warn)",
	Open: "bg-(--gk-good)",
	Stopped: "bg-(--gk-bad)",
};

export function MarketPanel({
	acts,
	activeThreadId,
	composerAgentId,
	headingRef,
	now,
	onBack,
	onClose,
	onCloseOrder,
	onPickKeeper,
	onPlaceOrder,
	onServe,
	reduceMotion,
	snapshot,
	threadView,
	view,
}: {
	/** With the act layer: counts and keeper states come from the acts. */
	acts?: MarketPanelActs;
	activeThreadId: string | null;
	/** The shopkeeper the composer is addressed to, if one was picked. */
	composerAgentId: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	now: number;
	/** Back from an order to its shop (when it has one). */
	onBack?: () => void;
	onClose: () => void;
	onCloseOrder: () => void;
	onPickKeeper: (agentId: string) => void;
	onPlaceOrder: (agentId: string | undefined, prompt: string) => void;
	onServe: (threadId: string) => void;
	reduceMotion: boolean;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode;
	view: MarketPanelView;
}) {
	const tl = useLiteralMessages();
	const composerRef = useRef<HTMLDivElement>(null);
	if (view.kind === "thread") {
		const { order, shop } = view;
		const title = orderTitle(order?.thread);
		const eyebrow = order
			? [slipNumber(order), shop?.name].filter(Boolean).join(" · ")
			: (shop?.name ?? "Market Street");
		return (
			<GameSheet
				backLabel={
					shop ? tl("Back to {shopName}", { shopName: shop.name }) : undefined
				}
				closeLabel="Close order"
				data-market-panel=""
				data-testid="market-panel"
				data-view="thread"
				eyebrow={eyebrow}
				headingRef={headingRef}
				label={tl("Order: {title}", { title })}
				onBack={shop ? onBack : undefined}
				onClose={onClose}
				sheetKey={order?.thread.id ?? "new"}
				subtitle={
					order ? (
						<>
							<BoardStatusDot status={order.status} />
							{THREAD_STATUS_LABELS[order.status]}
						</>
					) : undefined
				}
				title={title}
			>
				{threadView}
			</GameSheet>
		);
	}
	const { shop } = view;
	const busy = acts ? acts.busy(shop.id) : shop.busy;
	const sign = acts ? acts.sign(shop.id) : busy ? "Busy" : "Open";
	const recipients = orderRecipients(shop, snapshot);
	const keeper = composerAgentId ?? recipients[0]?.id;
	return (
		<GameSheet
			closeLabel={tl("Leave {shopName}", { shopName: shop.name })}
			data-market-panel=""
			data-testid="market-panel"
			data-view="shop"
			eyebrow={shopKindText(shop)}
			footer={
				<div data-market-composer="" ref={composerRef}>
					<InterfaceComposer
						agents={recipients}
						defaultAgentId={keeper}
						key={`${shop.id}:${keeper ?? ""}`}
						label={tl("New order at {shopName}", { shopName: shop.name })}
						onSubmit={({ agentId, prompt }) => onPlaceOrder(agentId, prompt)}
						placeholder="Describe what you need…"
						submitLabel="Place order"
					/>
				</div>
			}
			headingRef={headingRef}
			label={shop.name}
			leading={
				<span
					aria-hidden="true"
					className="grid size-10 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-plate-sunk)"
				>
					<Store className="size-5" strokeWidth={2.25} />
				</span>
			}
			onClose={onClose}
			sheetKey={shop.id}
			subtitle={
				<span className="flex items-center gap-1.5">
					<span
						aria-hidden="true"
						className={cn(
							"size-2 rounded-full",
							SIGN_DOT[sign] ?? "bg-(--gk-good)"
						)}
					/>
					<span data-testid="market-open-sign">{sign}</span>
					<span aria-hidden="true">·</span>
					{plural(shop.orders.length, "order")}
					{subtitleNeed(shop, acts)}
				</span>
			}
			title={shop.name}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pt-3 [scrollbar-width:thin]">
				{shop.agents.length > 0 ? (
					<ul
						aria-label="Behind the counter"
						className="flex flex-wrap gap-2 px-3"
					>
						{shop.agents.map((agent) => {
							const state = acts?.keeper(agent.id);
							const working = state
								? state.working
								: agent.status === "working";
							const words = state?.words ?? (working ? "working" : "idle");
							const picked = agent.id === keeper;
							return (
								<li key={agent.id}>
									<button
										aria-label={tl("New order for {agentName}, {state}", {
											agentName: agent.name,
											state: words,
										})}
										aria-pressed={picked}
										className={cn(
											"flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
											picked && "border-primary bg-muted"
										)}
										data-testid="market-keeper"
										onClick={() => onPickKeeper(agent.id)}
										type="button"
									>
										<span
											aria-hidden="true"
											className={cn(
												"size-1.5 rounded-full",
												working ? "bg-success" : "bg-muted-foreground/60"
											)}
										/>
										<span className="font-medium">{agent.name}</span>
									</button>
								</li>
							);
						})}
					</ul>
				) : (
					<p className="px-3 text-muted-foreground text-sm">
						Nobody behind the counter: any agent can take an order here.
					</p>
				)}
				<OrderBoard
					activeThreadId={activeThreadId}
					acts={acts?.statuses}
					now={now}
					onCloseOrder={onCloseOrder}
					onNewOrder={() =>
						composerRef.current?.querySelector("textarea")?.focus()
					}
					onServe={onServe}
					reduceMotion={reduceMotion}
					shop={shop}
					snapshot={snapshot}
				/>
			</div>
		</GameSheet>
	);
}
