import {
	type ReactNode,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";

interface SlotStore {
	listeners: Set<() => void>;
	node: ReactNode;
}

function LiveSlot({ store }: { store: SlotStore }) {
	return useSyncExternalStore(
		(listener) => {
			store.listeners.add(listener);
			return () => {
				store.listeners.delete(listener);
			};
		},
		() => store.node
	);
}

/**
 * A stable element that renders the newest `node`. A node rebuilt on every
 * render (the tab-bar model picker) can then sit inside memoized title bar
 * actions: the slot re-renders on its own, and the actions keep their identity,
 * so they are not pushed to the shared title bar again.
 */
export function useLiveSlot(node: ReactNode) {
	const [store] = useState<SlotStore>(() => ({
		listeners: new Set(),
		node,
	}));
	const [element] = useState(() => <LiveSlot store={store} />);
	useLayoutEffect(() => {
		if (store.node === node) {
			return;
		}
		store.node = node;
		for (const listener of [...store.listeners]) {
			listener();
		}
	});
	return element;
}
