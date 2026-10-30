// Virtualized sidebar chat lists keep only a window of rows in the DOM, but
// range selection, Shift+Arrow and multi-row drags read row order from the DOM
// (see `sidebar-chat-selection.tsx`). Each virtual list registers a handle on
// its container element so those gestures see every row in visual order and
// can bring an unmounted neighbour into view before focusing it.

const VIRTUAL_LIST_ATTRIBUTE = "data-sidebar-chat-virtual-list";
export const VIRTUAL_LIST_SELECTOR = `[${VIRTUAL_LIST_ATTRIBUTE}]`;

/** Spread on the element that contains a virtual list's rows. */
export const SIDEBAR_CHAT_VIRTUAL_LIST_ATTRIBUTES = {
	[VIRTUAL_LIST_ATTRIBUTE]: "",
};

export interface SidebarVirtualChatRows {
	/** Every chat id in the list in visual order, mounted or not. */
	orderedIds: () => string[];
	/** Scroll the row for `id` into view and focus it once it mounts. */
	reveal: (id: string) => void;
}

const handles = new WeakMap<Element, SidebarVirtualChatRows>();

export function registerSidebarVirtualChatRows(
	element: Element,
	handle: SidebarVirtualChatRows
): () => void {
	handles.set(element, handle);
	return () => {
		if (handles.get(element) === handle) {
			handles.delete(element);
		}
	};
}

export function sidebarVirtualChatRows(
	element: Element
): SidebarVirtualChatRows | undefined {
	return handles.get(element);
}

/** The registered virtual list a row element renders inside, if any. */
export function enclosingVirtualChatRows(
	element: Element
): SidebarVirtualChatRows | undefined {
	const list = element.parentElement?.closest(VIRTUAL_LIST_SELECTOR);
	return list ? handles.get(list) : undefined;
}
