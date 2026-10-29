import type { WorkbenchItem } from "@ryu/workbench/model";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { useWorkbenchSlots } from "./workbench-slots.tsx";

export interface WorkbenchItemHostProps {
	renderItem: (item: WorkbenchItem) => ReactNode;
}

function createItemContainer(itemId: string): HTMLDivElement {
	const element = document.createElement("div");
	element.className = "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden";
	element.dataset.workbenchHostedItem = itemId;
	return element;
}

/**
 * Owns one permanent DOM portal container per live workbench item. Moving an
 * item only reparents that container between registered slots; React always
 * renders through the same portal target, so route state is never remounted.
 */
export function WorkbenchItemHost({ renderItem }: WorkbenchItemHostProps) {
	const { state } = useDesktopWorkbench();
	const { getSlot, slotEpoch } = useWorkbenchSlots();
	const fallbackRef = useRef<HTMLDivElement | null>(null);
	const containersRef = useRef(new Map<string, HTMLDivElement>());

	for (const item of state.items) {
		if (!containersRef.current.has(item.id)) {
			containersRef.current.set(item.id, createItemContainer(item.id));
		}
	}

	useLayoutEffect(() => {
		const fallback = fallbackRef.current;
		if (!fallback) {
			return;
		}

		const liveItemIds = new Set(state.items.map((item) => item.id));
		for (const [itemId, container] of containersRef.current) {
			if (!liveItemIds.has(itemId)) {
				container.remove();
				containersRef.current.delete(itemId);
				continue;
			}
			const group = state.groups.find((candidate) =>
				candidate.itemIds.includes(itemId)
			);
			const slot =
				group?.activeItemId === itemId ? getSlot(group.id, itemId) : null;
			const destination = slot ?? fallback;
			if (container.parentElement !== destination) {
				destination.append(container);
			}
		}
	}, [getSlot, slotEpoch, state.groups, state.items]);

	return (
		<>
			<div aria-hidden className="hidden" ref={fallbackRef} />
			{state.items.map((item) => {
				const container = containersRef.current.get(item.id);
				return container
					? createPortal(renderItem(item), container, item.id)
					: null;
			})}
		</>
	);
}
