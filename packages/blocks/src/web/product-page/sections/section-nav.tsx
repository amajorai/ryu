export interface ProductSectionNavItem {
	readonly id: string;
	readonly label: string;
}

/**
 * Scroll margin for a section the sub-nav links to: the sticky site header
 * (4.5rem) plus the sub-nav itself, with room to spare.
 */
export const SECTION_ANCHOR_CLASS = "scroll-mt-32";

/** Fewer anchors than this and a sub-nav is noise. */
export const MIN_SECTION_NAV_ITEMS = 3;

/**
 * The in-page sub-nav: the product name, then an anchor per rendered section.
 * It sticks just below the site header (4.5rem: the header's p-4 around its
 * h-10 row) and slides up to the viewport edge while a floating header has
 * scrolled away (`data-header-hidden`). It scrolls sideways inside itself on
 * phones, never the page. Plain anchors, no script.
 */
export const SECTION_NAV_STICKY_CLASS =
	"sticky top-18 z-40 transition-[top] duration-300 ease-out motion-reduce:transition-none [body:has([data-header-hidden])_&]:top-0";

export function ProductSectionNav({
	productName,
	items,
}: {
	productName: string;
	items: readonly ProductSectionNavItem[];
}) {
	if (items.length < MIN_SECTION_NAV_ITEMS) {
		return null;
	}
	return (
		<nav
			aria-label="On this page"
			className={`${SECTION_NAV_STICKY_CLASS} border-border border-y bg-background/85 backdrop-blur-md`}
			data-testid="product-section-nav"
		>
			<div className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6">
				<span className="hidden shrink-0 font-heading font-medium text-foreground text-sm md:inline">
					{productName}
				</span>
				<ul className="-mx-2 flex min-w-0 flex-1 gap-1 overflow-x-auto py-2 md:mx-0">
					{items.map((item) => (
						<li className="shrink-0" key={item.id}>
							<a
								className="inline-flex min-h-9 items-center rounded-full px-3 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								href={`#${item.id}`}
							>
								{item.label}
							</a>
						</li>
					))}
				</ul>
			</div>
		</nav>
	);
}
