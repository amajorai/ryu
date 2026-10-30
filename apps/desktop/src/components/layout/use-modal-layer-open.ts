import { useEffect, useState } from "react";

/**
 * Modal layers that cover the window navigation cluster: dialog, alert dialog
 * and drawer scrims, and any sheet other than the phone-width navigation sheet
 * the cluster's own sidebar toggle opens.
 */
export const MODAL_LAYER_SELECTOR = [
	'[data-slot="dialog-overlay"]',
	'[data-slot="alert-dialog-overlay"]',
	'[data-slot="drawer-overlay"]',
	'[data-slot="sheet-content"]:not([data-sidebar="sidebar"])',
].join(", ");

function holdsModalLayer(node: Node): boolean {
	return (
		node instanceof Element &&
		(node.matches(MODAL_LAYER_SELECTOR) ||
			node.querySelector(MODAL_LAYER_SELECTOR) !== null)
	);
}

function addsModalLayer(records: MutationRecord[]): boolean {
	for (const record of records) {
		for (const node of record.addedNodes) {
			if (holdsModalLayer(node)) {
				return true;
			}
		}
	}
	return false;
}

function removesNodes(records: MutationRecord[]): boolean {
	return records.some((record) => record.removedNodes.length > 0);
}

/**
 * Whether a modal layer is open anywhere in the document.
 *
 * A stylesheet `html:has(<layer>) <cluster>` rule would say the same, but it
 * made every DOM insertion restyle the whole document (Chromium re-checks a
 * `:has()` subject on each insertion below it and invalidates its subtree), so
 * a streamed reply spent ~175 ms per chunk in style recalc. This observer only
 * inspects the nodes each mutation adds, and searches the document again only
 * after a removal while a layer is open.
 */
export function useModalLayerOpen(): boolean {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const root = document.body;
		let current = root.querySelector(MODAL_LAYER_SELECTOR) !== null;
		setOpen(current);
		const observer = new MutationObserver((records) => {
			let next = current;
			if (current) {
				next = removesNodes(records)
					? root.querySelector(MODAL_LAYER_SELECTOR) !== null
					: true;
			} else {
				next = addsModalLayer(records);
			}
			if (next !== current) {
				current = next;
				setOpen(next);
			}
		});
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, []);
	return open;
}
