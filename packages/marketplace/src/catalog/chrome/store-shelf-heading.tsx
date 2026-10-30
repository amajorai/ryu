// packages/marketplace/src/catalog/chrome/store-shelf-heading.tsx
//
// The ONE shelf heading every Store list renders above a card row ("Featured",
// "Text and Embedding", "Team rituals", "From the community", …).
//
// It exists because the same shelf was styled four different ways across the
// Store: Home and Apps/Plugins used a medium, base-size tight title,
// Engines/Agents/Workflows/contributed tabs used a muted uppercase micro-label,
// and Installed used the same micro-label with a different tracking. Switching
// tabs changed the typography of the section titles, which made one surface read
// as several. The heading is a shared primitive so a new tab cannot invent a
// fifth treatment. It is the section-title role: `text-sm font-semibold`.
//
// `action` is retained for non-navigational headings (for example a count or
// badge). Navigational headings always use the same icon-only chevron so a shelf
// cannot grow a different text CTA on another surface.

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

function ShelfChevron() {
	return (
		<HugeiconsIcon
			aria-hidden
			className="size-4 shrink-0 self-center text-muted-foreground transition-transform duration-(--duration-fast) group-hover:translate-x-0.5 motion-reduce:transition-none"
			icon={ArrowRight01Icon}
		/>
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
		<span className="min-w-0 truncate font-semibold text-sm">{children}</span>
	);
	const trailingAction = onOpen ? <ShelfChevron /> : action;
	// The accessible name carries the shelf title, so "Open section" alone never
	// reaches a screen reader once per shelf.
	const buttonLabel =
		isNativeText(children) && !openLabel.includes(children)
			? `${openLabel}: ${children}`
			: openLabel;
	return (
		<div className={cn("mb-2 px-1", className)}>
			<h3 className="group flex items-center gap-2">
				{onOpen ? (
					<button
						aria-label={buttonLabel}
						className="group flex min-w-0 items-center gap-1 text-left"
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
				<p className="text-detail text-muted-foreground">{description}</p>
			) : null}
		</div>
	);
}
