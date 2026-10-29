// Keeps every open chat tab's page mounted while an interface shows one thread at
// a time. Switching threads would otherwise unmount the other tab's ChatPage, and
// its unmount cleanup aborts a resumed stream and clears its busy state.
//
// Each tab's tree is rendered once, through a portal into a DOM host that never
// changes. The host is parked in a hidden, inert container, and the interface's
// thread slot moves the shown tab's host into itself. Moving a DOM node does not
// remount the React tree inside it, which is what a plain "shown tab only"
// element, or a move between two React parents, would do.

import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	type Tab,
} from "@/src/contexts/TabsContext.tsx";

const HOST_CLASS = "flex size-full flex-col overflow-hidden";

interface RetainedChatHosts {
	/** The stable DOM host for one tab's tree. */
	hostFor: (tabId: string) => HTMLElement;
	/** Return a host to the hidden container. */
	park: (host: HTMLElement) => void;
}

const RetainedChatHostsContext = createContext<RetainedChatHosts | null>(null);

/**
 * Renders every retained chat tab and provides the thread slot with their hosts.
 * `children` (the interface body) may mount a {@link RetainedThreadSlot}.
 */
export function RetainedChatTrees({
	children,
	renderTab,
	shownTabId,
	tabs,
}: {
	children: ReactNode;
	/** The page for one tab (the route outlet, wired to close that tab). */
	renderTab: (tab: Tab) => ReactNode;
	shownTabId: string | null;
	/** The chat tabs to keep mounted: loaded (not unloaded) chat tabs. */
	tabs: readonly Tab[];
}) {
	const hostsRef = useRef(new Map<string, HTMLElement>());
	const parkingRef = useRef<HTMLDivElement>(null);

	const park = useCallback((host: HTMLElement) => {
		parkingRef.current?.append(host);
	}, []);
	const hostFor = useCallback(
		(tabId: string) => {
			let host = hostsRef.current.get(tabId);
			if (!host) {
				host = document.createElement("div");
				host.className = HOST_CLASS;
				hostsRef.current.set(tabId, host);
				park(host);
			}
			return host;
		},
		[park]
	);
	const api = useRef<RetainedChatHosts>({ hostFor, park });

	// Park hosts that are not placed anywhere yet, and drop the hosts of tabs
	// that closed or unloaded.
	useLayoutEffect(() => {
		const live = new Set(tabs.map((tab) => tab.id));
		for (const [id, host] of hostsRef.current) {
			if (!live.has(id)) {
				host.remove();
				hostsRef.current.delete(id);
			} else if (!host.parentNode) {
				park(host);
			}
		}
	});

	return (
		<RetainedChatHostsContext.Provider value={api.current}>
			<div
				data-testid="ryu-interface-retained-chats"
				hidden
				inert
				ref={parkingRef}
			/>
			{tabs.map((tab) =>
				createPortal(
					<IsActiveTabProvider
						isActive={tab.id === shownTabId}
						key={`${tab.id}:${tab.navToken ?? 0}`}
					>
						<CurrentTabIdProvider tabId={tab.id}>
							{renderTab(tab)}
						</CurrentTabIdProvider>
					</IsActiveTabProvider>,
					hostFor(tab.id),
					tab.id
				)
			)}
			{children}
		</RetainedChatHostsContext.Provider>
	);
}

/**
 * The interface's thread view for `tabId`: moves that tab's retained tree into
 * this slot while mounted, and back to the hidden container when it unmounts or
 * another tab takes over.
 */
export function RetainedThreadSlot({ tabId }: { tabId: string }) {
	const hosts = useContext(RetainedChatHostsContext);
	const slotRef: RefObject<HTMLDivElement | null> = useRef(null);
	useLayoutEffect(() => {
		const slot = slotRef.current;
		if (!(slot && hosts)) {
			return;
		}
		const host = hosts.hostFor(tabId);
		slot.append(host);
		return () => {
			if (host.parentNode === slot) {
				hosts.park(host);
			}
		};
	}, [hosts, tabId]);
	return <div className="size-full" ref={slotRef} />;
}
