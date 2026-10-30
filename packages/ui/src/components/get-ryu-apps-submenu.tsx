import {
	Download01Icon,
	LaptopIcon,
	PuzzleIcon,
	SmartPhone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	GET_RYU_APPS_LABEL,
	otherRyuAppSurfaces,
	type RyuAppSurface,
	type RyuAppSurfaceId,
	type RyuCurrentSurface,
} from "../lib/ryu-app-surfaces.ts";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "./dropdown-menu.tsx";

const SURFACE_ICONS = {
	desktop: LaptopIcon,
	extension: PuzzleIcon,
	mobile: SmartPhone01Icon,
} satisfies Record<RyuAppSurfaceId, IconSvgElement>;

interface GetRyuAppsSubmenuProps {
	current: RyuCurrentSurface;
	iconClassName?: string;
	/**
	 * Whether the host build has a mobile app-store listing. Each host reads it
	 * from its own public build env; without one, Mobile is not promoted.
	 */
	mobileListed: boolean;
	/**
	 * Open a website-relative `/download#…` path in the surface's own way. The
	 * literal path type lets typed-route hosts pass it to their router as is.
	 */
	onOpen: (path: RyuAppSurface["path"]) => void;
}

/** User-nav submenu that cross-promotes the other installable Ryu clients. */
export function GetRyuAppsSubmenu({
	current,
	iconClassName = "size-4",
	mobileListed,
	onOpen,
}: GetRyuAppsSubmenuProps) {
	const surfaces = otherRyuAppSurfaces(current, { mobileListed });
	if (surfaces.length === 0) {
		return null;
	}
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className={iconClassName} icon={Download01Icon} />
				{GET_RYU_APPS_LABEL}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="min-w-60">
				{surfaces.map((surface) => {
					return (
						<DropdownMenuItem
							key={surface.id}
							onClick={() => onOpen(surface.path)}
						>
							<HugeiconsIcon
								className={iconClassName}
								icon={SURFACE_ICONS[surface.id]}
							/>
							<span className="flex-1">{surface.label}</span>
							<span className="ml-3 text-muted-foreground text-xs">
								{surface.description}
							</span>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
