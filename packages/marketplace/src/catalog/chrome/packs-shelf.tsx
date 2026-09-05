// packages/marketplace/src/catalog/chrome/packs-shelf.tsx
//
// The Packs shelf inside the Skills catalog section. Two states:
//
//   - **Browse** — a horizontal row of TCG-style pack cards ([`PackCatalogCard`]).
//     Each pack is a repo of skills (or a custom user manifest) installable as a
//     unit. "Open" fans the pack into its member skills.
//   - **Open** — the pack's member skills rendered as the redesigned
//     [`SkillBadgeCard`] tiles, with a back control returning to the shelf.
//
// The shelf is fed entirely by the host's `useSkillPacks` hook (Core-backed on
// desktop, federated or omitted on web), so it renders nothing when the host has
// no pack seam.

import { ArrowLeft01Icon, PackageIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { useCatalogHost } from "../host.tsx";
import type { SkillPacksState } from "../pack-types.ts";
import PackCatalogCard from "./pack-catalog-card.tsx";
import SkillBadgeCard from "./skill-badge-card.tsx";

export default function PacksShelf() {
	const host = useCatalogHost();
	const usePacks = host.useSkillPacks;
	if (!usePacks) {
		return null;
	}
	return (
		<PacksShelfBody canInstall={host.install !== null} state={usePacks()} />
	);
}

function PacksShelfBody({
	canInstall,
	state,
}: {
	canInstall: boolean;
	state: SkillPacksState;
}) {
	const { error, install, installing, opened, open, packs, loading, refresh } =
		state;
	const onInstall = useCallback(
		(id: string) => {
			install(id).catch(() => {
				// Errors surface through the host's error state.
			});
		},
		[install]
	);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const openButtons = useRef<Array<HTMLButtonElement | null>>([]);
	const activeIndex = Math.min(
		hoveredIndex ?? focusedIndex ?? 0,
		Math.max(packs.length - 1, 0)
	);
	const isExpanded = hoveredIndex !== null || focusedIndex !== null;

	const focusPack = (index: number) => {
		if (index < 0 || index >= packs.length) {
			return;
		}
		setFocusedIndex(index);
		openButtons.current[index]?.focus();
	};

	const handlePackKeyDown = (
		index: number,
		event: KeyboardEvent<HTMLButtonElement>
	) => {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}

		let nextIndex: number | null = null;
		switch (event.key) {
			case "ArrowLeft":
			case "ArrowUp":
				nextIndex = Math.max(index - 1, 0);
				break;
			case "ArrowRight":
			case "ArrowDown":
				nextIndex = Math.min(index + 1, packs.length - 1);
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = packs.length - 1;
				break;
			default:
				return;
		}

		event.preventDefault();
		focusPack(nextIndex);
	};

	// Opened pack: reveal the member skills, with a back affordance.
	if (opened) {
		return (
			<section className="border-border/60 border-b pb-4">
				<div className="mx-auto w-full max-w-4xl px-4">
					<div className="mb-3 flex items-center gap-2">
						<Button
							aria-label="Back to packs"
							onClick={() => open("")}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
							Packs
						</Button>
						<div className="min-w-0">
							<h3 className="truncate font-medium text-sm">{opened.name}</h3>
							<p className="truncate text-muted-foreground text-xs">
								{opened.description}
							</p>
						</div>
					</div>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{opened.members.map((member) => (
							<SkillBadgeCard
								busy={installing === opened.id}
								card={{
									id: member.id,
									name: member.name,
									slug: member.id.split("/").at(-1) ?? member.id,
									source: opened.id,
									installs: 0,
									downloads: 0,
									installed: member.installed,
									description: member.description,
								}}
								installed={member.installed}
								key={member.id}
								onInstall={() => onInstall(opened.id)}
								onOpen={() => {}}
							/>
						))}
					</div>
				</div>
			</section>
		);
	}

	if (loading && packs.length === 0) {
		return (
			<section className="border-border/60 border-b pb-4">
				<div className="flex items-center justify-center gap-2 p-4 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading packs…
				</div>
			</section>
		);
	}

	if (error && packs.length === 0) {
		return (
			<section className="border-border/60 border-b pb-4">
				<Empty className="py-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={PackageIcon} />
						</EmptyMedia>
						<EmptyTitle>Couldn't load packs</EmptyTitle>
						<EmptyDescription>{error}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button onClick={refresh} size="sm" variant="ghost">
							Try again
						</Button>
					</EmptyContent>
				</Empty>
			</section>
		);
	}

	if (packs.length === 0) {
		return null;
	}

	return (
		<section className="border-border/60 border-b pb-4">
			<div className="mx-auto w-full max-w-4xl px-4">
				<div className="mb-2 flex items-end justify-between gap-3">
					<div>
						<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Skill packs
						</h3>
						<p className="mt-1 text-muted-foreground text-xs">
							Collect a complete agent loadout in one pack.
						</p>
					</div>
					<span className="shrink-0 text-muted-foreground text-xs">
						{formatCount(packs.length) ?? "—"} pack
						{packs.length === 1 ? "" : "s"}
					</span>
				</div>
				<div
					aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
					aria-label="Agent pack card stack"
					className={cn(
						"flex items-end justify-center overflow-x-auto py-5 pr-10 pl-10",
						"[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					)}
					onPointerLeave={() => setHoveredIndex(null)}
				>
					{packs.map((pack, index) => (
						<PackCatalogCard
							className={cn(
								"w-44 shrink-0 origin-bottom transition-[transform,z-index] duration-300 ease-out motion-reduce:transition-none",
								index > 0 && "-ml-10"
							)}
							installable={canInstall}
							installing={installing === pack.id}
							key={pack.id}
							onInstall={() => onInstall(pack.id)}
							onOpen={() => open(pack.id)}
							onOpenBlur={() => setFocusedIndex(null)}
							onOpenFocus={() => setFocusedIndex(index)}
							onOpenKeyDown={(event) => handlePackKeyDown(index, event)}
							onPointerEnter={() => setHoveredIndex(index)}
							openButtonRef={(element) => {
								openButtons.current[index] = element;
							}}
							openTabIndex={0}
							pack={pack}
							style={{
								zIndex:
									activeIndex === index
										? packs.length + 1
										: packs.length - index,
								transform: `translateX(${isExpanded ? (index - activeIndex) * 3.5 : 0}rem) rotate(${(index - (packs.length - 1) / 2) * 2.5 + (isExpanded ? (index - activeIndex) * 4 : 0)}deg) scale(${activeIndex === index && isExpanded ? 1.03 : 1})`,
							}}
						/>
					))}
				</div>
			</div>
		</section>
	);
}
