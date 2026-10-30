import { createContext, type ReactNode, useContext } from "react";

export interface StoreCardLinkProps {
	ariaLabel: string;
	className: string;
	href: string;
	onClick?: () => void;
}

export type StoreCardLinkRenderer = (props: StoreCardLinkProps) => ReactNode;

const StoreCardLinkContext = createContext<StoreCardLinkRenderer | null>(null);

/** Let a host preserve its router semantics without making this package import
 * a framework-specific Link component. The web host supplies Next Link so its
 * card anchors participate in intercepting routes; desktop falls back to the
 * plain anchor below. */
export function StoreCardLinkProvider({
	children,
	renderLink,
}: {
	children: ReactNode;
	renderLink: StoreCardLinkRenderer;
}) {
	return (
		<StoreCardLinkContext.Provider value={renderLink}>
			{children}
		</StoreCardLinkContext.Provider>
	);
}

/** The host's link renderer for a card's stretched target, if it supplied one. */
export function useStoreCardLinkRenderer(): StoreCardLinkRenderer | null {
	return useContext(StoreCardLinkContext);
}
