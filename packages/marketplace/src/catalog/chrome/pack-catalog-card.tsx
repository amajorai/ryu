import visualStyles from "../../marketplace-visual.module.css";

// packages/marketplace/src/catalog/chrome/pack-catalog-card.tsx
//
// The TCG-style **pack card** for the Skills catalog's Packs shelf. A pack is a
// collectable: a booster pack of skills. So the card reads as one — a stack of
// mini skill cards behind a face that carries the owner/org's mark, which fans
// out on hover the way a hand of cards does, and "opens" (reveals the member
// skills) on click.
//
// Design notes, so it stays distinct from every other Store card:
//
// - **It is not a `StoreCatalogCard` row.** That card is a horizontal
//   icon+text row with a lifecycle action on the right; a pack is a *collectable
//   object*, so this is a portrait tile — a fan of cards seen edge-on, a face
//   mark, the pack name and "N skills" below.
// - **The fan is decoration, not navigation.** The mini cards behind the face
//   are inert (they carry no hit target, no aria role); the whole tile is one
//   button that opens the pack. Each member's own card appears in the open view.
// - **The avatar is the pack's mark.** A pack is an `owner/repo`, so the
//   owner/org's GitHub avatar is what distinguishes one pack from another —
//   exactly the "logo spans the top half, centered" treatment the Skill cards
//   now share. The `seeded` fallback tiles from the id when no avatar resolves.

import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type CSSProperties,
	type FocusEventHandler,
	type KeyboardEventHandler,
	type PointerEventHandler,
	useState,
} from "react";
import type { SkillPackCard } from "../pack-types.ts";

/** GitHub avatar for an `owner/repo` pack id, when it is a real repo pack. */
export function packAvatarUrl(
	pack: Pick<SkillPackCard, "id"> & Partial<Omit<SkillPackCard, "id">>
): string | null {
	const parts = pack.id.split("/").filter(Boolean);
	if (parts.length < 2) {
		return null;
	}
	const [owner] = parts;
	if (!owner || owner.length === 0) {
		return null;
	}
	return `https://github.com/${owner}.png`;
}

/** How many mini cards fan out behind the face (capped so a 51-skill pack does
 *  not look like a deck of 51). */
const FAN_CARDS = 4;

/** The little skill-shaped tiles fanned behind the pack face. */
function FanCards({ pack }: { pack: SkillPackCard }) {
	return (
		<div aria-hidden className="absolute inset-x-2 top-2 bottom-[4.5rem]">
			{Array.from({ length: FAN_CARDS }, (_, i) => {
				// A tight fan: each card rotates a little more and peeks a little
				// further, like a hand fanned open. The middle card sits flattest so
				// the fan reads as a spread, not a wedge.
				const off = i - (FAN_CARDS - 1) / 2;
				const rotate = off * 7;
				const y = Math.abs(off) * 3;
				const paintStyle: PackFanPaintStyle = {
					"--marketplace-background": packSeededColor(pack, i),
				};
				const fanStyle: PackFanStyle = {
					"--marketplace-transform": `translateY(${y}px) rotate(${rotate}deg)`,
				};
				return (
					<div
						className={cn(
							"absolute inset-0 rounded-lg border border-border bg-card",
							visualStyles.transform
						)}
						key={i}
						style={fanStyle}
					>
						<div
							className={cn("h-1/3 rounded-t-lg", visualStyles.background)}
							style={paintStyle}
						/>
						<div className="flex h-2/3 items-center justify-center px-2">
							<div className="h-1.5 w-3/4 rounded-full bg-muted" />
						</div>
					</div>
				);
			})}
		</div>
	);
}

/** A stable per-pack gradient for the fan tiles, seeded from the id. */
function packSeededColor(pack: SkillPackCard, i: number): string {
	const hue = hashString(pack.id) + i * 37;
	return `hsl(${hue % 360} 45% 42%)`;
}

/** FNV-1a-ish string hash for stable per-pack art. */
function hashString(value: string): number {
	let hash = 2_166_136_261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16_777_619);
	}
	return Math.abs(hash);
}

export default function PackCatalogCard({
	pack,
	selected = false,
	installing = false,
	installed = false,
	onOpen,
	onInstall,
	className,
	style,
	installable = true,
	openButtonRef,
	openTabIndex = 0,
	onOpenBlur,
	onOpenFocus,
	onOpenKeyDown,
	onPointerEnter,
}: {
	pack: SkillPackCard;
	/** Draws the selected wash (the open pack). */
	selected?: boolean;
	/** Show the install spinner state. */
	installing?: boolean;
	/** Every member already installed — paints a done check. */
	installed?: boolean;
	/** Opens the pack to reveal its members. */
	onOpen: () => void;
	/** Installs the whole pack without opening it. */
	onInstall: () => void;
	/** Whether this host can actually install packs. */
	installable?: boolean;
	className?: string;
	style?: CSSProperties;
	/** Refers to the pack's open control for stack keyboard navigation. */
	openButtonRef?: (element: HTMLButtonElement | null) => void;
	/** Keeps every pack open control reachable in the tab order. */
	openTabIndex?: number;
	onOpenBlur?: FocusEventHandler<HTMLButtonElement>;
	onOpenFocus?: FocusEventHandler<HTMLButtonElement>;
	onOpenKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
	onPointerEnter?: PointerEventHandler<HTMLDivElement>;
}) {
	const tl = useLiteralMessages();
	const [imgFailed, setImgFailed] = useState(false);
	const avatar = packAvatarUrl(pack);
	// The pack's mark: the owner avatar when it resolves, else a seeded tile.
	const faceMark =
		avatar && !imgFailed ? (
			// a remote raster avatar is the
			// pack's identity mark; no bundle can pre-optimize a GitHub owner's avatar.
			<img
				alt=""
				className="size-full object-cover"
				onError={() => setImgFailed(true)}
				src={avatar}
			/>
		) : (
			<DitherAvatar className="size-full" name={pack.id} />
		);

	return (
		<div
			className={cn(
				"group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-foreground/25",
				selected && "border-foreground/30 bg-accent",
				className
			)}
			onPointerEnter={onPointerEnter}
			style={style}
		>
			{/* The fan spread sits behind the face and fans out on hover. */}
			<FanCards pack={pack} />
			{/* The pack face: top half is the mark, bottom holds name + count. */}
			<button
				aria-label={tl("Open the {name} pack ({memberCount} skills)", {
					name: pack.name,
					memberCount: pack.memberCount,
				})}
				className="relative z-10 flex aspect-[5/6] w-full cursor-pointer flex-col overflow-hidden rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
				onBlur={onOpenBlur}
				onClick={onOpen}
				onFocus={onOpenFocus}
				onKeyDown={onOpenKeyDown}
				ref={openButtonRef}
				tabIndex={openTabIndex}
				type="button"
			>
				<div className="relative h-1/2 w-full overflow-hidden">{faceMark}</div>
				<div className="flex flex-1 flex-col justify-between gap-1 p-3">
					<div className="min-w-0">
						<p className="truncate font-medium text-sm" title={pack.name}>
							{pack.name}
						</p>
						<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
							{pack.description}
						</p>
					</div>
					<div className="flex items-center justify-between">
						<span className="text-detail text-muted-foreground">
							{tl("{memberCount, plural, one {# skill} other {# skills}}", {
								memberCount: pack.memberCount,
							})}
						</span>
						{installed ? (
							<HugeiconsIcon
								className="size-3.5 text-status-success"
								icon={CheckmarkCircle02Icon}
							/>
						) : null}
					</div>
				</div>
			</button>
			{/* The install affordance rides the tile's corner so the pack can be
			    taken wholesale without opening it first. */}
			{installable ? (
				<div className="absolute right-2 bottom-2 z-20">
					<button
						aria-label={tl("Install the {name} pack", { name: pack.name })}
						className="flex size-8 cursor-pointer items-center justify-center rounded-full border border-border bg-background font-medium text-xs transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/40"
						onClick={(event) => {
							event.stopPropagation();
							onInstall();
						}}
						type="button"
					>
						{installing ? (
							<span className="size-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
						) : installed ? (
							<HugeiconsIcon
								className="size-3.5 text-status-success"
								icon={CheckmarkCircle02Icon}
							/>
						) : (
							"+"
						)}
					</button>
				</div>
			) : null}
		</div>
	);
}

interface PackFanStyle extends CSSProperties {
	"--marketplace-transform": string;
}
interface PackFanPaintStyle extends CSSProperties {
	"--marketplace-background": string;
}
