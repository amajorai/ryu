import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { ReactNode, RefObject } from "react";
import type { OrderTab, WarehouseOrder } from "./warehouse-model.ts";
import {
	CreateOrder,
	OrderConversation,
	OrderDetail,
} from "./warehouse-order.tsx";
import { OrdersList } from "./warehouse-orders.tsx";

/**
 * The clipboard's panel for the current view: the orders list, an order's
 * detail, Create order, or the open order's conversation. Split out of
 * `warehouse-interface.tsx`.
 */

export type PanelView = "create" | "detail" | "list" | "thread";

interface WarehousePanelProps {
	agents: InterfaceAgent[];
	counts: Record<OrderTab, number>;
	createAgentId: string | undefined;
	fulfiller: InterfaceAgent | undefined;
	headingRef: RefObject<HTMLHeadingElement | null>;
	hoveredOrderId: string | null;
	loadByAgent: ReadonlyMap<string, number>;
	loading: boolean;
	now: number;
	onBack: () => void;
	onBackFromThread: () => void;
	onClearFulfiller: () => void;
	onCreate: () => void;
	onFulfil: () => void;
	onHover: (orderId: string | null) => void;
	onPick: (agentId: string) => void;
	onSelect: (orderId: string) => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	onTab: (tab: OrderTab) => void;
	openOrder: WarehouseOrder | undefined;
	selectedOrder: WarehouseOrder | undefined;
	selectedOrderId: string | null;
	tab: OrderTab;
	threadView: ReactNode;
	totalOrders: number;
	view: PanelView;
	visibleOrders: WarehouseOrder[];
}

export function WarehousePanel({
	agents,
	counts,
	createAgentId,
	fulfiller,
	headingRef,
	hoveredOrderId,
	loadByAgent,
	loading,
	now,
	onBack,
	onBackFromThread,
	onClearFulfiller,
	onCreate,
	onFulfil,
	onHover,
	onPick,
	onSelect,
	onSubmit,
	onTab,
	openOrder,
	selectedOrder,
	selectedOrderId,
	tab,
	threadView,
	totalOrders,
	view,
	visibleOrders,
}: WarehousePanelProps) {
	if (view === "thread") {
		return (
			<OrderConversation
				agents={agents}
				headingRef={headingRef}
				now={now}
				onBack={onBackFromThread}
				order={openOrder}
				threadView={threadView}
			/>
		);
	}
	if (view === "create") {
		return (
			<CreateOrder
				agentId={createAgentId}
				agents={agents}
				headingRef={headingRef}
				loadByAgent={loadByAgent}
				onBack={onBack}
				onPick={onPick}
				onSubmit={onSubmit}
			/>
		);
	}
	if (view === "detail" && selectedOrder) {
		return (
			<OrderDetail
				agents={agents}
				headingRef={headingRef}
				now={now}
				onBack={onBack}
				onFulfil={onFulfil}
				order={selectedOrder}
			/>
		);
	}
	return (
		<OrdersList
			counts={counts}
			fulfiller={fulfiller}
			hoveredOrderId={hoveredOrderId}
			loading={loading}
			now={now}
			onClearFulfiller={onClearFulfiller}
			onCreate={onCreate}
			onHover={onHover}
			onSelect={onSelect}
			onTab={onTab}
			orders={visibleOrders}
			selectedOrderId={selectedOrderId}
			shownOrders={counts.all}
			tab={tab}
			totalOrders={totalOrders}
		/>
	);
}
