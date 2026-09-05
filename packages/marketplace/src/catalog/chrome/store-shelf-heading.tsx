// packages/marketplace/src/catalog/chrome/store-shelf-heading.tsx
//
// The ONE shelf heading every Store list renders above a card row ("Featured",
// "Text and Embedding", "Team rituals", "From the community", …).
//
// It exists because the same shelf was styled four different ways across the
// Store: Home and Apps/Plugins used `font-medium text-base tracking-tight`,
// Engines/Agents/Workflows/contributed tabs used a muted uppercase micro-label,
// and Installed used the same micro-label with a different tracking. Switching
// tabs changed the typography of the section titles, which made one surface read
// as several. The heading is a shared primitive so a new tab cannot invent a
// fifth treatment — the App Store shelf title (semibold, base, tight) wins,
// because it is what Home (the front door) and the two biggest catalogs use.
//
// `action` is retained for non-navigational headings (for example a count or
// badge). Navigational headings always use the same icon-only chevron so a shelf
// cannot grow a different text CTA on another surface.

import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

function ShelfChevron() {
	return (
		<span
			aria-hidden="true"
			className="t-learn-chevron inline-flex text-muted-foreground transition-transform duration-350 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none"
		>
			<svg fill="none" height="16" viewBox="0 0 16 16" width="16">
				<path
					className="origin-[10px_8px] transition-transform duration-350 ease-out group-hover:rotate-[8deg] motion-reduce:transition-none"
					d="M6 4L10 8"
					stroke="currentColor"
					strokeLinecap="round"
				/>
				<path
					className="origin-[10px_8px] transition-transform duration-350 ease-out group-hover:rotate-[-8deg] motion-reduce:transition-none"
					d="M10 8L6 12"
					stroke="currentColor"
					strokeLinecap="round"
				/>
			</svg>
		</span>
	);
}

export default function StoreShelfHeading({
	children,
	description,
	action,
	onOpen,
	className,
	openLabel = "Open section",
}: {
	/** Trailing affordance for a non-navigational heading (e.g. a count badge). */
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	/** Optional second line under the title. */
	description?: ReactNode;
	/** Accessible name for the navigational heading button. */
	openLabel?: string;
	/** Makes the title (and any `action`) one clickable target — used by shelves
	 *  that jump to the full realm. The button lives INSIDE the heading so the
	 *  shelf keeps its heading semantics either way. */
	onOpen?: () => void;
}) {
	const title = (
		<span className="min-w-0 truncate font-medium text-base tracking-tight">
			{children}
		</span>
	);
	const trailingAction = onOpen ? <ShelfChevron /> : action;
	return (
		<div className={cn("mb-2 px-1", className)}>
			<h3 className="group flex items-baseline gap-2">
				{onOpen ? (
					<button
						aria-label={openLabel}
						className="group flex min-w-0 items-baseline gap-2 text-left"
						onClick={onOpen}
						type="button"
					>
						{title}
						{trailingAction}
					</button>
				) : (
					<>
						{title}
						{trailingAction}
					</>
				)}
			</h3>
			{description ? (
				<p className="text-muted-foreground text-xs">{description}</p>
			) : null}
		</div>
	);
}
