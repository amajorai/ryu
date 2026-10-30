// packages/marketplace/src/creators/creators-tab.tsx
//
// The Marketplace Creators tab: a directory of publishing organizations and a
// profile page for each one. Surface-agnostic like the money-layer tabs: the
// reads, the follow control, and listing navigation come from the injected
// `MarketplaceHost.creators` service, so web and desktop render the same UI.

import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { useCallback, useMemo, useState } from "react";
import { useMarketplaceHostOptional } from "../host.tsx";
import { creatorRouteHandle } from "./creator-format.ts";
import { CreatorProfileView } from "./creator-profile-view.tsx";
import type { MarketplaceCreatorListing } from "./creator-types.ts";
import { CreatorsDirectory } from "./creators-directory.tsx";

export { CreatorCard } from "./creators-directory.tsx";

/**
 * The Creators tab. `handle` / `onHandleChange` let a surface own the open
 * profile (the web mirrors it into the URL); left uncontrolled, the tab keeps
 * it in local state. `onOpenListing` overrides the host's listing navigation
 * for a surface whose navigation lives in the page rather than the host.
 */
export function CreatorsTab({
	handle,
	onHandleChange,
	onOpenListing,
}: {
	handle?: string | null;
	onHandleChange?: (handle: string | null) => void;
	onOpenListing?: (listing: MarketplaceCreatorListing) => void;
}) {
	const hostService = useMarketplaceHostOptional()?.creators;
	const service = useMemo(
		() =>
			hostService && onOpenListing
				? { ...hostService, openListing: onOpenListing }
				: hostService,
		[hostService, onOpenListing]
	);
	const [localHandle, setLocalHandle] = useState<string | null>(null);
	const openHandle = handle === undefined ? localHandle : handle;
	const setOpenHandle = useCallback(
		(next: string | null) => {
			setLocalHandle(next);
			onHandleChange?.(next);
		},
		[onHandleChange]
	);

	if (!service) {
		return (
			<Empty appearance="bordered" className="min-h-64">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={UserGroupIcon} />
					</EmptyMedia>
					<EmptyTitle>Creators are not available here</EmptyTitle>
					<EmptyDescription>
						Sign in to a Ryu account to browse Marketplace creators.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	if (openHandle) {
		return (
			<CreatorProfileView
				handle={openHandle}
				key={openHandle}
				onBack={() => setOpenHandle(null)}
				service={service}
			/>
		);
	}
	return (
		<CreatorsDirectory
			onOpen={(creator) => setOpenHandle(creatorRouteHandle(creator))}
			service={service}
		/>
	);
}
