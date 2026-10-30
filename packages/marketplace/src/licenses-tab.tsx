// packages/marketplace/src/licenses-tab.tsx
//
// The active org's owned paid items (purchase history). Surface-agnostic: the
// owned-licenses data comes from the injected host (`useLicenses`), so desktop
// (Better-Auth bearer -> :3000) and web (session cookie -> :3000) render the exact
// same UI. Degrades cleanly when signed out / with no active org. Subscription
// rows offer "Manage" when the host can open a license (`openLicense`).
// `layout="settings"` renders the same data as an iOS-style settings section
// (no page frame or h2) for the organization console; the default `"page"`
// keeps the Store/marketplace tab framing.

import {
	Alert02Icon,
	CheckmarkBadge04Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { useMarketplaceHost } from "./host.tsx";
import { NoOrgState, SignedOutState } from "./states.tsx";
import { formatPrice, type OwnedLicense } from "./types.ts";

/**
 * `className` adjusts the outer frame (e.g. to align with a host page).
 * `layout="settings"` drops the page frame and header for a settings pane.
 */
export function LicensesTab({
	className,
	layout = "page",
}: {
	className?: string;
	/** Its own Store/marketplace page (default), or a settings pane. */
	layout?: "page" | "settings";
} = {}) {
	const {
		openLicense,
		openMarketplace,
		openOrganization,
		openSignIn,
		useLicenses,
	} = useMarketplaceHost();
	const { licenses, loading, error, authed, refresh } = useLicenses();

	if (!authed) {
		return (
			<SignedOutState
				action={
					openSignIn ? (
						<Button onClick={() => void openSignIn()} size="sm">
							Sign in
						</Button>
					) : null
				}
				description="Your purchases are tied to your organization. Sign in to see the items you own."
				title="Sign in to view your licenses"
			/>
		);
	}
	if (error && error.kind === "no_org") {
		return (
			<NoOrgState
				action={
					openOrganization ? (
						<Button onClick={() => void openOrganization()} size="sm">
							Choose an organization
						</Button>
					) : null
				}
				message={error.message}
				title="No organization selected"
			/>
		);
	}

	const loadFailed = Boolean(error && error.kind !== "no_org");

	if (layout === "settings") {
		return (
			<SettingsSection
				className={className}
				headerAction={
					<Button onClick={() => refresh()} size="sm" variant="ghost">
						<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
						Refresh
					</Button>
				}
				title="Licenses"
			>
				<LicensesSettingsBody
					licenses={licenses}
					loadFailed={loadFailed}
					loading={loading}
					onBrowse={openMarketplace}
					onManage={openLicense}
					onRetry={() => refresh()}
				/>
			</SettingsSection>
		);
	}

	return (
		<div className={cn("mx-auto max-w-2xl px-6 py-8", className)}>
			<div className="mb-6 flex items-center justify-between">
				<h2 className="font-medium text-lg">My licenses</h2>
				<Button onClick={() => refresh()} size="sm" variant="ghost">
					<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
					Refresh
				</Button>
			</div>

			<LicensesBody
				licenses={licenses}
				loadFailed={loadFailed}
				loading={loading}
				onBrowse={openMarketplace}
				onManage={openLicense}
				onRetry={() => refresh()}
			/>
		</div>
	);
}

/** Only a subscription license has a renewal to manage. */
export function licenseIsManageable(license: OwnedLicense): boolean {
	return Boolean(license.stripeSubscriptionId);
}

type ManageLicense = (licenseId: string) => Promise<void> | void;

/** Kind, non-active status, and "Renewal off" badges beside a license name. */
function LicenseBadges({ license }: { license: OwnedLicense }) {
	const isActive = license.status === "active";
	return (
		<>
			<Badge variant="outline">{license.itemKind}</Badge>
			{isActive ? null : <Badge variant="destructive">{license.status}</Badge>}
			{isActive && license.cancelAtPeriodEnd ? (
				<Badge variant="secondary">Renewal off</Badge>
			) : null}
		</>
	);
}

/** The `v1.2.3 · Jun 1, 2026` version and purchase-date line. */
function LicenseMeta({ license }: { license: OwnedLicense }) {
	return (
		<p className="text-muted-foreground text-xs">
			v{license.itemVersion} ·{" "}
			{new Date(license.purchasedAt).toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			})}
		</p>
	);
}

/** The price plus, for a manageable subscription, its Manage button. */
function LicenseActions({
	license,
	onManage,
}: {
	license: OwnedLicense;
	onManage?: ManageLicense;
}) {
	const tl = useLiteralMessages();
	const manageable = Boolean(onManage) && licenseIsManageable(license);
	return (
		<div className="flex shrink-0 items-center gap-3">
			<span className="font-medium text-sm tabular-nums">
				{formatPrice(license.priceMinor, license.currency)}
			</span>
			{manageable ? (
				<Button
					aria-label={tl("Manage {itemName}", {
						itemName: license.itemName ?? license.itemId,
					})}
					onClick={() => void onManage?.(license.id)}
					size="sm"
					variant="outline"
				>
					Manage
				</Button>
			) : null}
		</div>
	);
}

function LicenseRow({
	license,
	onManage,
}: {
	license: OwnedLicense;
	onManage?: ManageLicense;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium text-sm">
						{license.itemName ?? license.itemId}
					</span>
					<LicenseBadges license={license} />
				</div>
				<LicenseMeta license={license} />
			</div>
			<LicenseActions license={license} onManage={onManage} />
		</div>
	);
}

interface LicensesBodyProps {
	licenses: OwnedLicense[];
	loadFailed: boolean;
	loading: boolean;
	onBrowse?: () => Promise<void> | void;
	onManage?: ManageLicense;
	onRetry: () => void;
}

/** One muted settings card for the loading, load-failure, and empty states. */
function LicensesSettingsNotice({
	action,
	description,
	title,
}: {
	action?: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<SettingsCard>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-sm">{title}</p>
					<p className="text-muted-foreground text-xs leading-snug">
						{description}
					</p>
				</div>
				{action}
			</div>
		</SettingsCard>
	);
}

/** Settings-pane rendering of {@link LicensesBody}'s states and rows. */
function LicensesSettingsBody({
	loadFailed,
	loading,
	licenses,
	onBrowse,
	onManage,
	onRetry,
}: LicensesBodyProps) {
	if (loading && licenses.length === 0) {
		return (
			<SettingsCard>
				<Spinner className="size-4" />
			</SettingsCard>
		);
	}
	if (loadFailed && licenses.length === 0) {
		return (
			<LicensesSettingsNotice
				action={
					<Button onClick={onRetry} size="sm" variant="outline">
						<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
						Retry
					</Button>
				}
				description="Something went wrong while loading your purchases. Check your connection and try again."
				title="Couldn't load your licenses"
			/>
		);
	}
	if (licenses.length === 0) {
		return (
			<LicensesSettingsNotice
				action={
					onBrowse ? (
						<Button onClick={() => void onBrowse()} size="sm">
							Browse the marketplace
						</Button>
					) : null
				}
				description="Paid items you buy from the marketplace appear here. Free items don't need a license."
				title="No purchases yet"
			/>
		);
	}
	return (
		<SettingsGroup>
			{licenses.map((license) => (
				<SettingsItem
					actions={<LicenseActions license={license} onManage={onManage} />}
					key={license.id}
					title={
						<>
							<span className="truncate">
								{license.itemName ?? license.itemId}
							</span>
							<LicenseBadges license={license} />
						</>
					}
				>
					<LicenseMeta license={license} />
				</SettingsItem>
			))}
		</SettingsGroup>
	);
}

function LicensesBody({
	loadFailed,
	loading,
	licenses,
	onBrowse,
	onManage,
	onRetry,
}: LicensesBodyProps) {
	if (loading && licenses.length === 0) {
		return <Spinner size="default" />;
	}
	if (loadFailed && licenses.length === 0) {
		return (
			<Empty>
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
					<Button onClick={onRetry} size="sm" variant="ghost">
						<HugeiconsIcon className="mr-2 size-3.5" icon={Refresh01Icon} />
						Retry
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (licenses.length === 0) {
		return (
			<Empty>
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
				{onBrowse ? (
					<EmptyContent>
						<Button onClick={() => void onBrowse()} size="sm">
							Browse the marketplace
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}
	return (
		<div className="overflow-hidden rounded-lg bg-card">
			<div className="divide-y">
				{licenses.map((license) => (
					<LicenseRow key={license.id} license={license} onManage={onManage} />
				))}
			</div>
		</div>
	);
}
