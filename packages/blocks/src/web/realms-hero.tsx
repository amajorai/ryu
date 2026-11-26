import type { ReactNode } from "react";
import { ProductRealmSelector } from "./product-realm-selector.tsx";
import { RealmsHeroSurface } from "./realms-hero-surface.tsx";
import StartupPrograms from "./startup-programs.tsx";

// A server component: only the hero surface needs the client (its seasonal sky
// follows the visitor's calendar and theme). The product realm cards below it are
// static markup and no longer ship or hydrate as client code.
export default function RealmsHero({
	hiddenProductIds,
	children,
}: {
	/** Product slugs the host has not rolled out; their cards are left out. */
	hiddenProductIds?: readonly string[];
	/** Sections the host places between the partner strip and the product cards. */
	children?: ReactNode;
} = {}) {
	return (
		<div className="bg-background text-foreground" data-testid="realms-hero">
			<RealmsHeroSurface />
			<StartupPrograms className="mt-0 px-6 pb-0 md:mt-0 md:pb-0" />
			{children}
			<ProductRealmSelector hiddenProductIds={hiddenProductIds} />
		</div>
	);
}
