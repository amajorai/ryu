/**
 * Remembers the scroll offsets inside one hosted workbench item so they survive
 * the host reparenting it. Moving a subtree out of the document, or into the
 * host's `display: none` parking slot, drops every scroll box in it, so a tab
 * that comes back to the front would otherwise always open scrolled to the top.
 *
 * Offsets are recorded from the item's own scroll events (a capturing listener
 * on the item root, since `scroll` does not bubble) and only while the item is
 * shown, so the reset that parking causes is never recorded as the position.
 */
export interface ScrollMemory {
	dispose: () => void;
	/** Stop recording: the item is about to be parked out of view. */
	park: () => void;
	/** Resume recording and put every remembered offset back. */
	restore: () => void;
}

interface Offset {
	left: number;
	top: number;
}

export function createScrollMemory(root: HTMLElement): ScrollMemory {
	const offsets = new Map<Element, Offset>();
	let parked = false;
	const record = (event: Event) => {
		const target = event.target;
		if (parked || !(target instanceof Element) || !root.contains(target)) {
			return;
		}
		const { scrollLeft: left, scrollTop: top } = target;
		if (left === 0 && top === 0) {
			offsets.delete(target);
			return;
		}
		offsets.set(target, { left, top });
	};
	root.addEventListener("scroll", record, { capture: true, passive: true });
	return {
		dispose: () => {
			root.removeEventListener("scroll", record, { capture: true });
			offsets.clear();
		},
		park: () => {
			parked = true;
		},
		restore: () => {
			parked = false;
			for (const [element, { left, top }] of offsets) {
				if (!root.contains(element)) {
					offsets.delete(element);
					continue;
				}
				if (element.scrollTop !== top) {
					element.scrollTop = top;
				}
				if (element.scrollLeft !== left) {
					element.scrollLeft = left;
				}
			}
		},
	};
}
