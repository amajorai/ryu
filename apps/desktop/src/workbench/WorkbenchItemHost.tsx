import type { WorkbenchItem } from "@ryu/workbench/model";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { createScrollMemory, type ScrollMemory } from "./scroll-memory.ts";
import { useWorkbenchSlots } from "./workbench-slots.tsx";

export interface WorkbenchItemHostProps {
	renderItem: (item: WorkbenchItem) => ReactNode;
}

interface ItemContainer {
	element: HTMLDivElement;
	scroll: ScrollMemory;
}

function createItemContainer(itemId: string): ItemContainer {
	const element = document.createElement("div");
	element.className = "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden";
	element.dataset.workbenchHostedItem = itemId;
	return { element, scroll: createScrollMemory(element) };
}

/**
 * Owns one permanent DOM portal container per live workbench item. Moving an
 * item only reparents that container between registered slots; React always
 * renders through the same portal target, so route state is never remounted.
 * Reparenting resets the scroll boxes inside it, so each container remembers
 * its scroll offsets and puts them back once it is in a visible slot again.
 */
export function WorkbenchItemHost({ renderItem }: WorkbenchItemHostProps) {
	const { state } = useDesktopWorkbench();
	const { getSlot, slotEpoch } = useWorkbenchSlots();
	const fallbackRef = useRef<HTMLDivElement | null>(null);
	const containersRef = useRef(new Map<string, ItemContainer>());

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
				container.scroll.dispose();
				container.element.remove();
				containersRef.current.delete(itemId);
				continue;
			}
			const group = state.groups.find((candidate) =>
				candidate.itemIds.includes(itemId)
			);
			const slot =
				group?.activeItemId === itemId ? getSlot(group.id, itemId) : null;
			const destination = slot ?? fallback;
			if (container.element.parentElement === destination) {
				continue;
			}
			if (slot) {
				destination.append(container.element);
				container.scroll.restore();
			} else {
				container.scroll.park();
				destination.append(container.element);
			}
		}
	}, [getSlot, slotEpoch, state.groups, state.items]);

	return (
		<>
			<div aria-hidden className="hidden" ref={fallbackRef} />
			{state.items.map((item) => {
				const container = containersRef.current.get(item.id);
				return container
					? createPortal(renderItem(item), container.element, item.id)
					: null;
			})}
		</>
	);
}
