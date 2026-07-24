// packages/marketplace/src/catalog/chrome/store-catalog-card.tsx
//
// The one card every Store catalog list renders: borderless, no background at
// rest (just a hover/selected wash), a muted-background icon on the left, the
// name + a one-line description beside it, and the lifecycle action on the right.
// Shared so Apps, Plugins, Models, Skills, MCP, and Agents look identical.
//
// The row is NOT a single <button> (that would nest the action button inside it):
// the icon+text is one button that opens the preview, the action sits beside it.

import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	type DitherColor,
	isDitherColor,
} from "@ryu/ui/components/dither-kit/palette.ts";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { resolveCardIcon } from "../icon-url.ts";
import type { CardDither } from "../types.ts";

/** The four gradient directions dither-kit accepts. */
const DIRECTIONS: GradientDirection[] = ["up", "down", "left", "right"];

/** Normalize ONE untrusted colour token to a dither-kit `PixelColor`: a finite hue
 *  number, or a known palette-colour name. Anything else (typo'd name, NaN, object)
 *  → null, so a malformed remote card never reaches `fillOf`, which throws on an
 *  unknown name. */
function normalizeColor(value: unknown): DitherColor | number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (isDitherColor(value)) {
		return value;
	}
	return null;
}

/** A dither spec that is safe to hand to {@link DitherGradient}. `from` is
 *  guaranteed valid; `to`/`direction` are already validated (or omitted so the
 *  component's own defaults apply). */
interface SafeDither {
	direction?: GradientDirection;
	from: DitherColor | number;
	to?: DitherColor | number | "transparent";
}

/** Validate an untrusted {@link CardDither} into a {@link SafeDither}, or null when
 *  it can't paint. `from` MUST resolve (else the whole spec is dropped and the card
 *  falls back to its flat/`img` path); `to` accepts "transparent" or a valid colour
 *  (else omitted → transparent); an unknown `direction` is dropped (→ "up"). */
function normalizeDither(dither?: CardDither | null): SafeDither | null {
	if (!dither) {
		return null;
	}
	const from = normalizeColor(dither.from);
	if (from === null) {
		return null;
	}
	const safe: SafeDither = { from };
	if (dither.to === "transparent") {
		safe.to = "transparent";
	} else {
		const to = normalizeColor(dither.to);
		if (to !== null) {
			safe.to = to;
		}
	}
	if (
		typeof dither.direction === "string" &&
		DIRECTIONS.includes(dither.direction as GradientDirection)
	) {
		safe.direction = dither.direction as GradientDirection;
	}
	return safe;
}

export default function StoreCatalogCard({
	icon,
	brandIcon,
	iconId,
	iconUrl,
	iconBackground,
	dither,
	name,
	seedId,
	description,
	selected = false,
	onClick,
	action,
}: {
	/** Fallback glyph — rendered inside the rounded square when no `iconId`/`iconUrl`. */
	icon: ReactNode;
	/** A ready-made brand-mark node (e.g. `AgentCatalogLogo`, themed + its own
	 *  fallback). Wins over the generative dither avatar the way `iconId`/`iconUrl`
	 *  do, so a card with a real logo shows it instead of a placeholder tile. */
	brandIcon?: ReactNode;
	/** An Icon-primitive id (Iconify `prefix:name`, bare Hugeicons name). Wins over
	 *  `iconUrl` and `icon`; painted with the current text colour. */
	iconId?: string | null;
	/** A resolvable icon image (Iconify/icons0.dev/remote logo). Wins over `icon`. */
	iconUrl?: string | null;
	/** Optional CSS background for the icon square (e.g. a solid/gradient colour). */
	iconBackground?: string;
	/** Optional dithered-gradient background for the icon square. Validated before
	 *  paint; a malformed spec is ignored and the flat/`img` path is used. Wins over
	 *  `iconBackground` when valid. */
	dither?: CardDither | null;
	name: string;
	/** Stable seed for the placeholder dither avatar — the item's unique id
	 *  (`namespace/name`, a model/skill id, …) when available, else the name. */
	seedId?: string | null;
	description?: string | null;
	selected?: boolean;
	onClick: () => void;
	/** The right-hand lifecycle control (see {@link StoreItemAction}). */
	action?: ReactNode;
}) {
	const safeDither = normalizeDither(dither);
	// Resolve the two icon fields: a raster logo from `icon_url` (any https host),
	// or a GitHub-image URL pasted into the `icon` field; a non-GitHub URL in the
	// `icon` field is dropped rather than fetched (see {@link resolveCardIcon}).
	const { iconId: resolvedIconId, iconUrl: resolvedIconUrl } = resolveCardIcon({
		icon: iconId,
		iconUrl,
	});
	// No icon of its own → a generative dither AVATAR seeded from the item's id/name
	// (deterministic, ~1.5T combinations via {@link DitherAvatar}), so every
	// placeholder reads as a distinct branded tile, not one repeated grey glyph.
	// A `brandIcon` counts as a real icon, so a card that ships a logo skips the
	// placeholder tile just like `iconId`/`iconUrl` do.
	const isPlaceholder = !(resolvedIconId || resolvedIconUrl || brandIcon);

	let iconContent: ReactNode;
	if (resolvedIconId) {
		iconContent = <Icon icon={resolvedIconId} size={20} />;
	} else if (resolvedIconUrl) {
		iconContent = (
			<img
				alt=""
				className="size-full object-cover"
				loading="lazy"
				src={resolvedIconUrl}
			/>
		);
	} else if (brandIcon) {
		iconContent = brandIcon;
	} else {
		iconContent = icon;
	}
	// A valid dither wins the background; else a flat colour; else the muted default.
	const flatBackground =
		!safeDither && iconBackground ? { background: iconBackground } : undefined;

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
						"relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg",
						safeDither ? "text-white" : "text-muted-foreground",
						isPlaceholder || safeDither || iconBackground ? "" : "bg-muted"
					)}
					style={flatBackground}
				>
					{isPlaceholder ? (
						<DitherAvatar
							animate={false}
							className="size-full"
							name={seedId || name}
						/>
					) : (
						<>
							{safeDither ? (
								<DitherGradient
									direction={safeDither.direction}
									from={safeDither.from}
									to={safeDither.to}
								/>
							) : null}
							<span className="relative flex items-center justify-center">
								{iconContent}
							</span>
						</>
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
