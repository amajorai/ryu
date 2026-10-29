// packages/marketplace/src/catalog/chrome/brand-image.tsx
//
// The one <img> every catalog surface uses for a listing's raster art, so the
// card and the detail hero can never disagree about how a logo is framed.
//
// Two things vary and both come from {@link resolveCardIcon}:
//
//   • `brand` — a BRAND mark (an `svgl:` id, a vendor's own logo) is letterboxed
//     inside the tile. Publisher cover art still fills it, which is what makes a
//     designed app tile read as a tile rather than a stamp on a coloured square.
//   • `dark` — svgl declares a per-theme pair for marks that need one. Both are
//     rendered and CSS picks, so switching theme never refetches or flashes.
//
// …and one that comes from the MANIFEST: `padding`, the author's own answer to
// "how much room does my logo need inside the square". Several product logos are
// drawn edge-to-edge in their own art and read as stickers at `p-0.5`.
//
// Any padding other than `none` also forces `object-contain`. That coupling is the
// whole point of the field rather than an implementation detail: a listing that
// declares a bare `iconUrl` and no `icon` is NOT in the brand lane, so it is
// painted `object-cover` — and inset on a cropped image is invisible. Padding
// without fit would have fixed the two svgl listings and silently done nothing for
// the raw-logo one, which is the case that needed it most.

import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";

/** How much room a logo asks for inside the icon square. */
export type IconPadding = "lg" | "md" | "none" | "sm";

const PAD = {
	none: "",
	sm: "p-0.5",
	md: "p-1.5",
	lg: "p-2.5",
} satisfies Record<IconPadding, string>;

/**
 * Validate a manifest-supplied padding value.
 *
 * Manifest presentation is validate-then-paint everywhere in this package
 * (`scrub_icon_dither`, the GitHub-image allowlist, `isSafeSlug`), and the wire
 * type is a plain string precisely so an unknown value cannot fail a manifest
 * parse. Anything unrecognized returns `null`, which means "author said nothing"
 * and leaves the default in place.
 */
export function normalizeIconPadding(
	value: string | null | undefined
): IconPadding | null {
	return value === "none" || value === "sm" || value === "md" || value === "lg"
		? value
		: null;
}

function ImageSource({
	source,
	className,
	fallback,
}: {
	source: string;
	className: string;
	fallback?: ReactNode;
}) {
	const [failedSource, setFailedSource] = useState<string | null>(null);
	if (failedSource === source) {
		return (
			<span className={className}>
				<span className="flex size-full items-center justify-center">
					{fallback}
				</span>
			</span>
		);
	}
	return (
		<img
			alt=""
			className={className}
			loading="lazy"
			onError={() => setFailedSource(source)}
			src={source}
		/>
	);
}

export default function BrandOrCoverImage({
	light,
	dark = null,
	brand = false,
	padding = null,
	className,
	fallback,
}: {
	/** True when this is a brand mark (contain + inset) rather than cover art. */
	brand?: boolean;
	className?: string;
	fallback?: ReactNode;
	/** Dark-theme variant, when the brand ships one. */
	dark?: string | null;
	/** Default (light-theme) image. */
	light: string;
	/** The listing's declared inset, already validated. `null` = not declared. */
	padding?: IconPadding | null;
}) {
	// The `?? (brand ? "sm" : "none")` default is load-bearing: it reproduces
	// today's framing byte-for-byte for every listing that declares nothing. A flat
	// `"none"` default would silently strip the `p-0.5` off every existing `svgl:`
	// mark in the store, and the field would ship as a visible regression.
	const pad = padding ?? (brand ? "sm" : "none");
	const fit =
		pad === "none"
			? brand
				? "object-contain"
				: "object-cover"
			: `object-contain ${PAD[pad]}`;
	if (!dark) {
		return (
			<ImageSource
				className={cn("size-full", fit, className)}
				fallback={fallback}
				source={light}
			/>
		);
	}
	return (
		<>
			<ImageSource
				className={cn("size-full dark:hidden", fit, className)}
				fallback={fallback}
				source={light}
			/>
			<ImageSource
				className={cn("hidden size-full dark:block", fit, className)}
				fallback={fallback}
				source={dark}
			/>
		</>
	);
}
