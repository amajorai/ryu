import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useContext, useId, useRef } from "react";
import { compactAge } from "./interface-renderer.ts";
import {
	ORDER_TABS,
	type OrderTab,
	tabLabel,
	type WarehouseOrder,
} from "./warehouse-model.ts";
import {
	Fulfiller,
	StagePill,
	WarehouseActsContext,
} from "./warehouse-parts.tsx";

const TAB_EMPTY: Record<OrderTab, { body: string; title: string }> = {
	all: {
		body: "Each conversation is an order. Create one and assign a picker to fulfil it.",
		title: "No orders yet",
	},
	exceptions: {
		body: "No failed or interrupted runs. Every order is moving.",
		title: "No exceptions",
	},
	ready: {
		body: "Nothing is waiting on you. Replies land here when an agent finishes.",
		title: "Nothing ready to ship",
	},
	unfulfilled: {
		body: "Every order has a reply. New requests start here.",
		title: "All orders fulfilled",
	},
};

/** The Stopped tab's empty state under acts (stops counted like the queue). */
const STOPPED_EMPTY = {
	body: "No run is stopped. Older failures that no longer need you stay under All.",
	title: "Nothing stopped",
};

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

function moveFocus(event: KeyboardEvent<HTMLElement>) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
		return;
	}
	const rows = [
		...(event.currentTarget.querySelectorAll<HTMLButtonElement>(
			"[data-order-row]"
		) ?? []),
	];
	const index = rows.indexOf(event.target as HTMLButtonElement);
	if (index === -1) {
		return;
	}
	event.preventDefault();
	const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
	next?.focus();
}

/**
 * The orders list: Shopify-style tabs over a dense table of orders (number
 * and items, stage, fulfiller, age). Selecting a row opens the order.
 */
export function OrdersList({
	counts,
	fulfiller,
	hoveredOrderId,
	loading,
	now,
	onClearFulfiller,
	onCreate,
	onHover,
	onSelect,
	onTab,
	orders,
	selectedOrderId,
	shownOrders,
	tab,
	totalOrders,
}: {
	counts: Record<OrderTab, number>;
	fulfiller: InterfaceAgent | undefined;
	hoveredOrderId: string | null;
	loading: boolean;
	now: number;
	onClearFulfiller: () => void;
	onCreate: () => void;
	onHover: (orderId: string | null) => void;
	onSelect: (orderId: string) => void;
	onTab: (tab: OrderTab) => void;
	orders: readonly WarehouseOrder[];
	selectedOrderId: string | null;
	/** Orders matching the fulfiller filter (all of them without one). */
	shownOrders: number;
	tab: OrderTab;
	totalOrders: number;
}) {
	const acts = useContext(WarehouseActsContext);
	const tabRefs = useRef(new Map<OrderTab, HTMLButtonElement>());
	const idBase = useId();
	const tl = useLiteralMessages();
	const tabId = (id: OrderTab) => `${idBase}-tab-${id}`;
	const panelId = `${idBase}-panel`;
	const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = ORDER_TABS.findIndex((item) => item.id === tab);
		const last = ORDER_TABS.length - 1;
		const targets = new Map<string, number>([
			["ArrowLeft", index === 0 ? last : index - 1],
			["ArrowRight", index === last ? 0 : index + 1],
			["End", last],
			["Home", 0],
		]);
		const target = targets.get(event.key);
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		const next = ORDER_TABS[target];
		if (next) {
			onTab(next.id);
			tabRefs.current.get(next.id)?.focus();
		}
	};
	const empty =
		shownOrders === 0
			? TAB_EMPTY.all
			: acts && tab === "exceptions"
				? STOPPED_EMPTY
				: TAB_EMPTY[tab];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
				<h2 className="font-semibold text-base text-foreground">Orders</h2>
				{loading ? null : (
					<span className="text-muted-foreground text-sm tabular-nums">
						{fulfiller ? `${shownOrders} of ${totalOrders}` : totalOrders}
					</span>
				)}
			</header>
			<div className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-3">
				<div
					aria-label="Order views"
					className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
					onKeyDown={onTabKeyDown}
					role="tablist"
				>
					{ORDER_TABS.map((item) => {
						const selected = item.id === tab;
						return (
							<button
								aria-controls={panelId}
								aria-selected={selected}
								className={cn(
									"flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									selected
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
								)}
								id={tabId(item.id)}
								key={item.id}
								onClick={() => onTab(item.id)}
								ref={(node) => {
									if (node) {
										tabRefs.current.set(item.id, node);
									} else {
										tabRefs.current.delete(item.id);
									}
								}}
								role="tab"
								tabIndex={selected ? 0 : -1}
								type="button"
							>
								{tabLabel(item.id, acts)}
								{loading || item.id === "all" ? null : (
									<span
										className={cn(
											"tabular-nums",
											item.id === "exceptions" && counts.exceptions > 0
												? "text-status-destructive"
												: "text-muted-foreground"
										)}
									>
										{counts[item.id]}
									</span>
								)}
							</button>
						);
					})}
				</div>
			</div>
			{fulfiller ? (
				<div className="flex shrink-0 items-center gap-2 border-border border-b px-4 py-2 text-muted-foreground text-xs">
					<span>Fulfiller</span>
					<span className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background ps-1.5 pe-0.5 text-foreground">
						<span className="font-medium">{fulfiller.name}</span>
						<button
							aria-label={tl("Clear fulfiller filter {name}", {
								name: fulfiller.name,
							})}
							className="flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={onClearFulfiller}
							type="button"
						>
							<X aria-hidden="true" className="size-3" />
						</button>
					</span>
				</div>
			) : null}
			<div
				aria-labelledby={tabId(tab)}
				className="@container min-h-0 flex-1 overflow-y-auto"
				id={panelId}
				role="tabpanel"
			>
				{loading ? (
					<ul
						aria-busy="true"
						aria-label="Loading orders"
						className="flex flex-col"
					>
						{SKELETON_ROWS.map((key) => (
							<li
								className="flex h-14 items-center gap-3 border-border border-b px-4"
								key={key}
							>
								<div className="flex flex-1 flex-col gap-1.5">
									<Skeleton className="h-3 w-16" radius="pill" />
									<Skeleton className="h-3 w-40" radius="pill" />
								</div>
								<Skeleton className="h-5 w-20" radius="pill" />
							</li>
						))}
					</ul>
				) : orders.length === 0 ? (
					<div className="flex flex-col items-start gap-1 px-4 py-10">
						<p className="font-medium text-foreground text-sm">{empty.title}</p>
						<p className="max-w-72 text-muted-foreground text-sm">
							{empty.body}
						</p>
						{shownOrders === 0 ? (
							<Button
								className="mt-3"
								onClick={onCreate}
								size="sm"
								type="button"
								variant="outline"
							>
								<Plus aria-hidden="true" data-icon="inline-start" />
								Create order
							</Button>
						) : null}
					</div>
				) : (
					<table className="w-full table-fixed border-collapse text-sm">
						<caption className="sr-only">Orders</caption>
						<thead className="sticky top-0 z-10 bg-(--wh-paper)">
							<tr className="h-9 border-border border-b text-left text-muted-foreground text-xs">
								<th className="ps-4 font-medium" scope="col">
									Order
								</th>
								<th className="w-[112px] font-medium" scope="col">
									Stage
								</th>
								<th
									className="@max-[400px]:hidden w-[100px] font-medium"
									scope="col"
								>
									Fulfiller
								</th>
								{acts ? null : (
									<th className="w-12 pe-4 text-right font-medium" scope="col">
										Age
									</th>
								)}
							</tr>
						</thead>
						<tbody onKeyDown={moveFocus}>
							{orders.map((order) => {
								const selected = order.id === selectedOrderId;
								const hovered = order.id === hoveredOrderId;
								return (
									<tr
										className={cn(
											"relative h-14 border-border border-b transition-colors",
											selected
												? "bg-muted"
												: hovered
													? "bg-muted/60"
													: "hover:bg-muted/60"
										)}
										data-order={order.id}
										key={order.id}
										onMouseEnter={() => onHover(order.id)}
										onMouseLeave={() => onHover(null)}
									>
										<td className="min-w-0 ps-4 pe-3">
											<button
												aria-current={selected ? "true" : undefined}
												className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												data-order-row={order.id}
												onClick={() => onSelect(order.id)}
												type="button"
											>
												<span className="font-mono font-semibold text-[13px] text-foreground tabular-nums leading-5 tracking-wide">
													{order.number}
												</span>
												<span className="w-full truncate text-[13px] text-foreground/80 leading-5">
													{order.thread.title}
												</span>
											</button>
										</td>
										<td className="pe-3">
											<StagePill stage={order.stage} stamp />
										</td>
										<td className="@max-[400px]:hidden min-w-0 pe-2">
											<Fulfiller
												agent={order.agent}
												className="flex text-[13px]"
											/>
										</td>
										{acts ? null : (
											<td className="pe-4 text-right text-[13px] text-muted-foreground tabular-nums">
												{compactAge(order.thread.updatedAt, now)}
											</td>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
