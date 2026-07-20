// packages/marketplace/src/catalog/chrome/store-catalog-card.tsx
//
// The one card every Store catalog list renders: borderless, no background at
// rest (just a hover/selected wash), a muted-background icon on the left, the
// name + a one-line description beside it, and the lifecycle action on the right.
// Shared so Apps, Plugins, Models, Skills, MCP, and Agents look identical.
//
// The row is NOT a single <button> (that would nest the action button inside it):
// the icon+text is one button that opens the preview, the action sits beside it.

import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

export default function StoreCatalogCard({
	icon,
	iconUrl,
	iconBackground,
	name,
	description,
	selected = false,
	onClick,
	action,
}: {
	/** Fallback glyph — rendered inside the rounded square when no `iconUrl`. */
	icon: ReactNode;
	/** A resolvable icon image (Iconify/icons0.dev/remote logo). Wins over `icon`. */
	iconUrl?: string | null;
	/** Optional CSS background for the icon square (e.g. a dither gradient). */
	iconBackground?: string;
	name: string;
	description?: string | null;
	selected?: boolean;
	onClick: () => void;
	/** The right-hand lifecycle control (see {@link StoreItemAction}). */
	action?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"group flex items-center gap-3 rounded-xl pr-2 transition-colors",
				selected ? "bg-accent" : "hover:bg-accent/50"
			)}
		>
			<button
				className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-2.5 text-left"
				onClick={onClick}
				type="button"
			>
				<span
					className={cn(
						"flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg text-muted-foreground",
						iconBackground ? "" : "bg-muted"
					)}
					style={iconBackground ? { background: iconBackground } : undefined}
				>
					{iconUrl ? (
						<img
							alt=""
							className="size-full object-cover"
							loading="lazy"
							src={iconUrl}
						/>
					) : (
						icon
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-sm">{name}</span>
					<span className="block truncate text-muted-foreground text-xs">
						{description || "No description provided."}
					</span>
				</span>
			</button>
			{action ? <div className="shrink-0">{action}</div> : null}
		</div>
	);
}
