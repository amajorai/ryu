// packages/marketplace/src/catalog/chrome/skill-badge-card.tsx
//
// The redesigned **skill card** for the Skills catalog — a collectable, like the
// Agent badge cards but deliberately NOT the same object:
//
//   - Both are portrait tiles, but an agent card is an employee badge (metal
//     ring, hired date, "employee of Ryu"); a skill is a card you collect, so
//     this one is a flat TCG-style card.
//   - The skill's owner/org **avatar spans the top half, centered** — the "whose
//     card is this" answer, the same identity-first treatment the pack cards
//     share. Below it, the skill name + one-line description.
//   - No metal, no ring, no hired line. The lifecycle action (Add / enabled
//     state) rides the card's corner.
//
// This is the card the Skills section renders in its grid (the shared
// `StoreCatalogCard` row stays for the other realms), so getting a skill feels
// like getting a Pokémon card: avatar art on top, name + effect text below.

import { Add01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, useState } from "react";
import { titleCase } from "../friendly.ts";
import type { SkillCard } from "../types.ts";

/** GitHub owner avatar for a skill id (`owner/repo/slug` → owner). */
export function skillAvatarUrl(card: SkillCard): string | null {
	const [owner] = (card.source || card.id).split("/");
	if (!owner || owner.length === 0) {
		return null;
	}
	return `https://github.com/${owner}.png`;
}

export default function SkillBadgeCard({
	card,
	selected = false,
	installed = false,
	busy = false,
	onOpen,
	onInstall,
	className,
	style,
}: {
	card: SkillCard;
	selected?: boolean;
	/** The skill is on disk (Add → a done check). */
	installed?: boolean;
	/** An install/enable toggle is in flight. */
	busy?: boolean;
	onOpen: () => void;
	onInstall: () => void;
	className?: string;
	style?: CSSProperties;
}) {
	const tl = useLiteralMessages();
	const [imgFailed, setImgFailed] = useState(false);
	const avatar = skillAvatarUrl(card);
	const art =
		avatar && !imgFailed ? (
			// a remote raster avatar is the
			// skill's identity mark; no bundle can pre-optimize a GitHub owner's avatar.
			<img
				alt=""
				className="size-full object-cover"
				onError={() => setImgFailed(true)}
				src={avatar}
			/>
		) : (
			<DitherAvatar className="size-full" name={card.id} />
		);

	return (
		<div
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/60 bg-card transition-colors hover:border-foreground/25",
				selected && "border-foreground/30 bg-accent",
				className
			)}
			style={style}
		>
			<button
				aria-label={tl("Open {name}", { name: card.name })}
				className="relative flex w-full cursor-pointer flex-col overflow-hidden rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
				onClick={onOpen}
				type="button"
			>
				{/* Avatar art spans the top half, centered. */}
				<div className="relative aspect-[5/3] w-full overflow-hidden">
					{art}
					<div className="absolute inset-0 bg-gradient-to-b from-black/10 to-transparent" />
				</div>
				{/* Name + one-line description below the art. */}
				<div className="flex min-h-24 flex-col justify-between gap-1 p-3">
					<div className="min-w-0">
						<p className="truncate font-medium text-sm" title={card.name}>
							{card.name}
						</p>
						<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
							{card.description?.trim() ||
								(card.installs > 0
									? tl("{source} · {installs} installs", {
											source: card.source,
											installs: card.installs,
										})
									: card.source) ||
								titleCase(card.slug)}
						</p>
					</div>
					<span className="type-compact truncate font-medium text-muted-foreground uppercase tracking-wide">
						{card.source}
					</span>
				</div>
			</button>
			{/* The lifecycle control rides the corner, above the card face. */}
			<div className="absolute top-2 right-2 z-20">
				<button
					aria-label={
						installed
							? tl("{name} is installed", { name: card.name })
							: tl("Add {name}", { name: card.name })
					}
					className="flex size-8 cursor-pointer items-center justify-center rounded-full border border-border/70 bg-background/90 font-medium text-xs shadow-sm backdrop-blur transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/40"
					onClick={(event) => {
						event.stopPropagation();
						onInstall();
					}}
					type="button"
				>
					{busy ? (
						<span className="size-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
					) : installed ? (
						<HugeiconsIcon
							className="size-3.5 text-status-success"
							icon={CheckmarkCircle02Icon}
						/>
					) : (
						<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
					)}
				</button>
			</div>
		</div>
	);
}
