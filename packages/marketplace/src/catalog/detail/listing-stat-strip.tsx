import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { safeHttpUrl } from "../safe-url.ts";

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

export interface ListingStat {
	icon?: IconSvgElement;
	/** Sentence-case caption — "Version", "Developer", "Rating". */
	label: string;
	/** Makes the whole cell a button — the rating cell jumps to the Reviews tab,
	 *  the health cell to Health. */
	onClick?: () => void;
	/** Optional second line under the value ("Ratings", "Updated 3d ago"). */
	sub?: ReactNode;
	/** The headline value. Kept short; a long one truncates rather than reflows. */
	value: ReactNode;
}

/** The divided meta row every app store puts directly under the hero. Replaces the
 *  inline flex-wrap `DetailMetaStrip` for the detail view: at 400px those items
 *  wrapped into an unreadable ribbon, and at 1200px they were a lonely single line
 *  of grey text where the store's headline facts should be. */
export function ListingStatStrip({ items }: { items: ListingStat[] }) {
	if (items.length === 0) {
		return null;
	}
	return (
		<div className="overflow-x-auto px-5 py-3 lg:px-7">
			{/* A flat row: a muted label over the value, separated by whitespace.
			    Each cell keeps a `min-w` floor so the row scrolls only once the
			    floors no longer fit. */}
			<div className="flex gap-6">
				{items.map((stat) => {
					const body = (
						<>
							<span className="text-detail text-muted-foreground">
								{stat.label}
							</span>
							{/* The value gets its OWN truncating span: a bare text node in a
							    flex row will not shrink below its min-content width. */}
							<span className="flex w-full min-w-0 items-center gap-1 font-medium text-foreground text-sm">
								{stat.icon ? (
									<HugeiconsIcon
										className="size-3.5 shrink-0 text-muted-foreground"
										icon={stat.icon}
									/>
								) : null}
								<span
									className="truncate"
									title={
										typeof stat.value === "string" ? stat.value : undefined
									}
								>
									{stat.value}
								</span>
							</span>
							{stat.sub ? (
								<span className="truncate text-muted-foreground/70 text-xs">
									{stat.sub}
								</span>
							) : null}
						</>
					);
					const className =
						"flex min-w-[7.5rem] flex-1 flex-col items-start gap-0.5 overflow-hidden text-left";
					return stat.onClick ? (
						<button
							className={cn(
								className,
								"-mx-2 rounded-lg px-2 py-1 transition-colors duration-(--duration-fast) hover:bg-muted hover:duration-0"
							)}
							key={stat.label}
							onClick={stat.onClick}
							type="button"
						>
							{body}
						</button>
					) : (
						<div className={cn(className, "py-1")} key={stat.label}>
							{body}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/** The screenshot rail. Renders NOTHING when the listing ships no screenshots —
 *  which today is all but one packaged manifest — so a wide dialog never opens on
 *  an empty band where a gallery is implied. */
export function ListingGalleryRail({
	screenshots,
	name,
	onOpen,
}: {
	screenshots?: string[] | null;
	name: string;
	/** Opens the lightbox. Host-injected: the desktop ships one, web does not. */
	onOpen?: (index: number) => void;
}) {
	const tl = useLiteralMessages();
	const safe = (screenshots ?? [])
		.map((url) => safeHttpUrl(url))
		.filter((url): url is string => Boolean(url));
	if (safe.length === 0) {
		return null;
	}
	return (
		<div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1">
			{safe.map((url, index) => {
				const frame = (
					<img
						alt={tl("{name} screenshot {number}", {
							name,
							number: String(index + 1),
						})}
						className="h-48 w-auto max-w-none rounded-xl bg-muted object-cover sm:h-60"
						loading="lazy"
						src={url}
					/>
				);
				return onOpen ? (
					<button
						className="shrink-0 snap-start transition-opacity hover:opacity-90"
						key={url}
						onClick={() => onOpen(index)}
						type="button"
					>
						{frame}
					</button>
				) : (
					<span className="shrink-0 snap-start" key={url}>
						{frame}
					</span>
				);
			})}
		</div>
	);
}
