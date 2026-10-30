// The account menu's content, in three sections separated by one rule each:
//   1. who you are: account switcher (with profile and web account rows),
//      online status, organization and plan, and the single upsell;
//   2. what you do: New ›, Settings, Downloads, Get Ryu apps ›, Help ›;
//   3. how it looks: Theme ›, Island, More › (community and legal links).
// A dev or non-Stable build adds one muted line on top.

import {
	ArrowUp01Icon,
	ArrowUpRight01Icon,
	Building03Icon,
	CreditCardIcon,
	DatabaseIcon,
	LaptopIcon,
	LegalDocument01Icon,
	MoreHorizontalIcon,
	PieChartIcon,
	Settings01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AgentAvailabilityDot,
	agentAvailabilityLabel,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { GetRyuAppsSubmenu } from "@ryu/ui/components/get-ryu-apps-submenu.tsx";
import { hasMobileStoreListing } from "@ryu/ui/lib/ryu-app-surfaces.ts";
import type { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import type { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import { preloadSettingsDialog } from "../settings/LazySettingsDialog.tsx";
import {
	AvailabilityOptions,
	AvailabilitySubmenu,
} from "./AvailabilityMenu.tsx";
import { BuildBadge } from "./BuildBadge.tsx";
import { CreateSubmenu } from "./CreateMenu.tsx";
import { HelpSubmenu } from "./HelpSubmenu.tsx";
import { IslandVisibilityMenuItem } from "./IslandVisibilityMenuItem.tsx";
import { AccountList } from "./nav-user-account-list.tsx";
import {
	CommunityItems,
	DesktopThemeSubmenu,
	DownloadsMenuItem,
	OrganizationsItem,
	WebAccountItems,
} from "./nav-user-menu-items.tsx";

// Vite inlines these at build time. Until one names a store listing,
// `/download#mobile` has nothing to install, so "Get Ryu apps" leaves Mobile out.
const MOBILE_APP_LISTED = hasMobileStoreListing(
	import.meta.env.VITE_IOS_APP_URL,
	import.meta.env.VITE_ANDROID_APP_URL
);

interface PlanView {
	creditsLeft: string;
	currentPlanLabel: string;
	hasSubscription: boolean;
	isLifetime: boolean;
	openLifetimeCheckout: () => void;
	openPricing: () => void;
	organization: unknown;
	resetDate: string;
	showUpsell: boolean;
	trialCountdown: string | null;
	upgradeTier: string | null;
}

/** Organization and plan in one submenu; its meta is the plan name. */
function PlanSubmenu({
	onOpenWeb,
	plan,
}: {
	onOpenWeb: (path: string) => void;
	plan: PlanView;
}) {
	const planRowLabel = plan.organization ? "Organization plan" : "Plan";
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={Building03Icon} />
				<span className="flex-1">
					{plan.organization ? "Organization" : "Plan"}
				</span>
				<span className="font-normal text-muted-foreground text-xs">
					{plan.currentPlanLabel}
				</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="min-w-60">
				<DropdownMenuItem disabled>
					<HugeiconsIcon className="size-4" icon={CreditCardIcon} />
					<span className="flex-1">{planRowLabel}</span>
					<span className="text-right font-normal text-muted-foreground text-xs">
						{plan.currentPlanLabel}
						{plan.trialCountdown ? (
							<span className="block tabular-nums">{plan.trialCountdown}</span>
						) : null}
					</span>
				</DropdownMenuItem>
				{plan.hasSubscription ? (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<HugeiconsIcon className="size-4" icon={PieChartIcon} />
							Usage remaining
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="min-w-60">
							<div className="flex flex-col gap-3 px-2 py-1.5">
								<div>
									<p className="text-muted-foreground text-xs">
										Credits left for organization
									</p>
									<p className="text-sm tabular-nums">{plan.creditsLeft}</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">Reset date</p>
									<p className="text-sm">{plan.resetDate}</p>
								</div>
							</div>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				) : null}
				<DropdownMenuSeparator />
				<OrganizationsItem onOpenWeb={onOpenWeb} />
				{plan.showUpsell ? (
					<DropdownMenuItem onClick={plan.openPricing}>
						<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
						See all plans
					</DropdownMenuItem>
				) : null}
				{plan.showUpsell && !plan.isLifetime ? (
					<DropdownMenuItem onClick={plan.openLifetimeCheckout}>
						<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
						Get Lifetime Access
					</DropdownMenuItem>
				) : null}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

export function NavUserAccountMenuContent({
	availability,
	botProduct,
	handleSignOut,
	isMenubar,
	openSettings,
	openWeb,
	plan,
	profilePath,
	surface,
	user,
}: {
	availability: ReturnType<typeof useUserAvailability>;
	botProduct: boolean;
	handleSignOut: () => void;
	isMenubar: boolean;
	openSettings: () => void;
	openWeb: (path: string) => void;
	plan: PlanView;
	profilePath: string;
	surface: ReturnType<typeof useAppSurface>["surface"];
	user: {
		id?: string;
		name?: string | null;
		email?: string | null;
		image?: string | null;
	} | null;
}) {
	const tl = useLiteralMessages();
	return (
		<DropdownMenuContent
			align="end"
			className="min-w-64"
			side="bottom"
			sideOffset={4}
		>
			{botProduct ? null : <BuildBadge />}
			<DropdownMenuGroup>
				{isMenubar && (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<AgentAvailabilityDot
								className="mx-1 size-1.5"
								status={availability.status}
							/>
							{tl("Availability: {status}", {
								status: agentAvailabilityLabel(availability.status),
							})}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="min-w-60">
							<AvailabilityOptions availability={availability} />
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
				<AccountList
					accountItems={
						botProduct ? undefined : (
							<WebAccountItems onOpenWeb={openWeb} profilePath={profilePath} />
						)
					}
					activeUser={user}
					onSignOutAll={handleSignOut}
				/>
				{isMenubar ? null : <AvailabilitySubmenu />}
				<PlanSubmenu onOpenWeb={openWeb} plan={plan} />
				{plan.showUpsell && plan.upgradeTier ? (
					<DropdownMenuItem
						aria-label={tl("Upgrade to {tier}", { tier: plan.upgradeTier })}
						onClick={plan.openPricing}
					>
						<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
						<span className="flex-1">Upgrade</span>
						<span className="font-normal text-muted-foreground text-xs">
							{plan.upgradeTier}
						</span>
					</DropdownMenuItem>
				) : null}
			</DropdownMenuGroup>
			<DropdownMenuSeparator />
			<DropdownMenuGroup>
				<CreateSubmenu />
				{botProduct ? (
					<>
						<DropdownMenuItem onClick={() => openWeb("/settings")}>
							<HugeiconsIcon className="size-4" icon={Settings01Icon} />
							Account
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => openWeb("/download")}>
							<HugeiconsIcon className="size-4" icon={LaptopIcon} />
							Download Ryu Build
						</DropdownMenuItem>
					</>
				) : (
					<DropdownMenuItem
						onClick={() => openSettings()}
						onFocus={preloadSettingsDialog}
						onPointerEnter={preloadSettingsDialog}
					>
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</DropdownMenuItem>
				)}
				{botProduct ? null : <DownloadsMenuItem />}
				{/* The same tree runs as the native shell, as apps/webapp (and its
				    Telegram Mini App) in a browser tab, and as the extension
				    dashboard; never promote the host the user is already in. */}
				{botProduct ? null : (
					<GetRyuAppsSubmenu
						current={
							surface === "web" || surface === "telegram" ? "web" : surface
						}
						iconClassName="size-4"
						mobileListed={MOBILE_APP_LISTED}
						onOpen={openWeb}
					/>
				)}
				<HelpSubmenu />
			</DropdownMenuGroup>
			<DropdownMenuSeparator />
			<DropdownMenuGroup>
				<DesktopThemeSubmenu />
				{ISLAND_ENABLED ? <IslandVisibilityMenuItem /> : null}
				{/* # 0.1.0: Capture toggle disabled — restore with the User Nav control.
				    <CaptureToggleMenuItem /> */}
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
						More
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="min-w-52">
						<CommunityItems invite={!botProduct} onOpenWeb={openWeb} />
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => openWeb("/terms")}>
							<HugeiconsIcon className="size-4" icon={LegalDocument01Icon} />
							Terms of Service
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => openWeb("/privacy")}>
							<HugeiconsIcon className="size-4" icon={Shield01Icon} />
							Privacy
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => openWeb("/dpa")}>
							<HugeiconsIcon className="size-4" icon={DatabaseIcon} />
							Data Processing Agreement
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuGroup>
		</DropdownMenuContent>
	);
}

export type { PlanView as NavUserPlanView };
