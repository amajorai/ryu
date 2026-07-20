// packages/marketplace/src/licenses-tab.tsx
//
// The active org's owned paid items (purchase history). Surface-agnostic: the
// owned-licenses data comes from the injected host (`useLicenses`), so desktop
// (Better-Auth bearer -> :3000) and web (session cookie -> :3000) render the exact
// same UI. Degrades cleanly when signed out / with no active org.

import {
	Alert02Icon,
	CheckmarkBadge04Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
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
import { useMarketplaceHost } from "./host.tsx";
import { NoOrgState, SignedOutState } from "./states.tsx";
import { formatPrice, type OwnedLicense } from "./types.ts";

export function LicensesTab() {
	const { useLicenses } = useMarketplaceHost();
	const { licenses, loading, error, authed, refresh } = useLicenses();

	if (!authed) {
		return (
			<SignedOutState
				description="Your purchases are tied to your organization. Sign in to see the items you own."
				title="Sign in to view your licenses"
			/>
		);
	}
	if (error && error.kind === "no_org") {
		return (
			<NoOrgState message={error.message} title="No organization selected" />
		);
	}

	const loadFailed = Boolean(error && error.kind !== "no_org");

	return (
		<div className="mx-auto max-w-2xl px-6 py-8">
			<div className="mb-6 flex items-center justify-between">
				<h2 className="font-semibold text-lg">My licenses</h2>
				<Button onClick={() => refresh()} size="sm" variant="ghost">
					<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
					Refresh
				</Button>
			</div>

			<LicensesBody
				licenses={licenses}
				loadFailed={loadFailed}
				loading={loading}
				onRetry={() => refresh()}
			/>
		</div>
	);
}

function LicenseRow({ license }: { license: OwnedLicense }) {
	const isActive = license.status === "active";
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium text-sm">
						{license.itemName ?? license.itemId}
					</span>
					<Badge className="text-[9px] uppercase" variant="outline">
						{license.itemKind}
					</Badge>
					{isActive ? null : (
						<Badge className="text-[9px]" variant="destructive">
							{license.status}
						</Badge>
					)}
				</div>
				<p className="text-muted-foreground text-xs">
					v{license.itemVersion} ·{" "}
					{new Date(license.purchasedAt).toLocaleDateString(undefined, {
						year: "numeric",
						month: "short",
						day: "numeric",
					})}
				</p>
			</div>
			<span className="shrink-0 font-medium text-sm tabular-nums">
				{formatPrice(license.priceMinor, license.currency)}
			</span>
		</div>
	);
}

function LicensesBody({
	loadFailed,
	loading,
	licenses,
	onRetry,
}: {
	loadFailed: boolean;
	loading: boolean;
	licenses: OwnedLicense[];
	onRetry: () => void;
}) {
	if (loading && licenses.length === 0) {
		return <Spinner className="size-5" />;
	}
	if (loadFailed && licenses.length === 0) {
		return (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Alert02Icon} />
					</EmptyMedia>
					<EmptyTitle>Couldn't load your licenses</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading your purchases. Check your
						connection and try again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="outline">
						<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
						Retry
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (licenses.length === 0) {
		return (
			<Empty className="py-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={CheckmarkBadge04Icon} />
					</EmptyMedia>
					<EmptyTitle>No purchases yet</EmptyTitle>
					<EmptyDescription>
						Paid items you buy from the marketplace appear here. Free items
						don't need a license.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	return (
		<div className="overflow-hidden rounded-lg bg-card">
			<div className="divide-y">
				{licenses.map((license) => (
					<LicenseRow key={license.id} license={license} />
				))}
			</div>
		</div>
	);
}
