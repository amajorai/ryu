"use client";

// Where this library's overlays (dialogs, sheets, popovers, menus, tooltips,
// selects) portal to. Unset, they portal to <body> as usual. A host that
// embeds untrusted or swappable content (the desktop's interfaces) provides
// an element inside that content's box, so its overlays stay inside it and
// can never cover the host's own chrome.

import { createContext, type ReactNode, useContext } from "react";

const PortalContainerContext = createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
	children,
	container,
}: {
	children?: ReactNode;
	container: HTMLElement | null;
}) {
	return (
		<PortalContainerContext.Provider value={container}>
			{children}
		</PortalContainerContext.Provider>
	);
}

/** The element overlays portal into, or undefined for <body>. */
export function usePortalContainer(): HTMLElement | undefined {
	return useContext(PortalContainerContext) ?? undefined;
}
