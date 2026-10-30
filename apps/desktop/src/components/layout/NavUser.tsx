import { AgentAvailabilityDot } from "@ryu/blocks/desktop/agent-availability.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { settingsApi, useSubscription } from "@ryu/settings";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useRef } from "react";
import { z } from "zod";
import { useAuthContext } from "@/contexts/auth-context.tsx";
import {
	FRONTEND_URL,
	getActiveUserId,
	useSession,
} from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { APPROVALS_ALIAS } from "@/src/contributions/companion-alias.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
// # 0.1.0: Capture toggle disabled — uncomment with the User Nav item below.
// import { CaptureToggleMenuItem } from "./CaptureToggleMenuItem.tsx";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import type { NotificationLayout } from "@/src/lib/notification-layout.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import {
	selectAggregate,
	useDownloadsStore,
} from "@/src/store/useDownloadsStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { useAppStore } from "../../store/useAppStore.ts";
import { DownloadCenter } from "../downloads/DownloadCenter.tsx";
import { InboxCenter } from "../inbox/InboxCenter.tsx";
import { CreateMenuHost } from "./CreateMenu.tsx";
import { NavUserAccountMenuContent } from "./nav-user-account-menu.tsx";
import { HideChromeContextMenu } from "./nav-user-menu-items.tsx";
import {
	formatDate,
	nextTierName,
	planLabel,
	showTrialCountdown,
	trialDaysLabel,
} from "./nav-user-plan.ts";

const TRAILING_SLASH_RE = /\/$/;
const sessionProfileFieldsSchema = z.object({ username: z.string().nullish() });

type FooterChromeKey = "inbox" | "user" | "downloads" | "settings";
const EMPTY_HIDDEN_CHROME = new Set<string>();

type NavUserProps =
	| { presentation: "menubar" }
	| {
			presentation?: "sidebar";
			hiddenChrome: ReadonlySet<string>;
			notificationLayout: NotificationLayout;
			onHideChrome: (key: FooterChromeKey) => void;
	  };

export { AccountList } from "./nav-user-account-list.tsx";
export {
	DesktopThemeSubmenu,
	DesktopWebAccountLinks,
} from "./nav-user-menu-items.tsx";

export function NavUser(props: NavUserProps) {
	const isMenubar = props.presentation === "menubar";
	const tl = useLiteralMessages();
	const hiddenChrome =
		props.presentation === "menubar" ? EMPTY_HIDDEN_CHROME : props.hiddenChrome;
	const notificationLayout =
		props.presentation === "menubar" ? "unified" : props.notificationLayout;
	const onHideChrome =
		props.presentation === "menubar" ? undefined : props.onHideChrome;
	const botProduct = useProductMode() === "bot";
	const { surface } = useAppSurface();
	const stepUp = useStepUp();
	// The footer keeps the downloads tray only while something needs attention
	// (in flight or failed); otherwise Downloads is a row in the account menu.
	const downloadsActive = useDownloadsStore((state) => {
		const aggregate = selectAggregate(state);
		return aggregate.inFlight > 0 || aggregate.failed > 0;
	});
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const { data: session, isPending } = useSession();
	const availability = useUserAvailability();
	const { verdict } = useEntitlementContext();
	// Whether ANY enabled app answers to the Inbox path. The tray previews that app's
	// data (pending approvals + quest check-off suggestions) and its every action ends
	// at `/inbox`, so with no owner it is a button that can only ever say "App not
	// enabled". Read from the live contributions feed rather than a baked
	// `@ryu/approvals`, so this affordance and the route it opens resolve from one
	// source. Approvals ships not pre-installed, so on a fresh install this is null.
	const inboxOwner = useCompanionAlias(APPROVALS_ALIAS);
	const { isLifetime } = useSubscription({
		accountId: session?.user?.id ?? null,
		organizationId: useActiveOrgId(),
		enabled: !isPending,
	});
	const {
		wallet,
		entitlement,
		loading: creditsLoading,
		error: creditsError,
	} = useCreditsWallet();
	const {
		billing: orgBillingStatus,
		organization,
		plan: organizationPlan,
	} = useOrgBillingStatus();
	const { handleSignOut } = useAuthContext();
	const isAuthenticated = useAppStore((s) => s.isAuthenticated);
	const oidcUser = useAppStore((s) => s.oidcUser);
	const userMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
	const sessionUser = session?.user;
	const user =
		sessionUser ??
		(oidcUser
			? {
					id: undefined,
					name: oidcUser.name ?? null,
					email: oidcUser.email ?? null,
					image: oidcUser.picture ?? null,
				}
			: null);
	const profile = sessionProfileFieldsSchema.safeParse(sessionUser);
	const profileHandle =
		(profile.success ? profile.data.username : null) ||
		user?.id ||
		getActiveUserId() ||
		null;
	const profilePath = profileHandle
		? `/u/${encodeURIComponent(profileHandle)}`
		: "/settings";

	if (isPending && !user && !isAuthenticated) {
		if (isMenubar) {
			return (
				<div
					aria-label="Loading account controls"
					className="flex size-6 items-center justify-center"
					data-testid="ryu-os-user-navigation"
					role="status"
				>
					<Spinner className="size-4" />
				</div>
			);
		}
		return (
			<SidebarMenu>
				<SidebarMenuItem>
					<div className="flex h-10 items-center justify-center">
						<Spinner className="size-4" />
					</div>
				</SidebarMenuItem>
			</SidebarMenu>
		);
	}

	if (!(user || isAuthenticated)) {
		return null;
	}

	const showInbox =
		!(botProduct || hiddenChrome.has("inbox")) && inboxOwner !== null;
	const showAnnouncements = !(botProduct || hiddenChrome.has("announcements"));
	const showUser = !hiddenChrome.has("user");
	const showDownloads = !(botProduct || hiddenChrome.has("downloads"));
	const showSettings = !(botProduct || hiddenChrome.has("settings"));
	const showNotifications =
		!botProduct &&
		(showInbox || (notificationLayout !== "split" && showAnnouncements));
	if (!(showNotifications || showUser || showDownloads || showSettings)) {
		return null;
	}

	const currentPlan = organization
		? organizationPlan
		: (entitlement?.plan ?? verdict?.plan ?? null);
	const currentPlanLabel = planLabel(
		currentPlan,
		!organization && verdict?.reason === "trial"
	);
	const trialCountdown = showTrialCountdown(verdict)
		? trialDaysLabel(verdict.daysLeftInTrial, tl)
		: null;
	const upgradeTier = nextTierName(currentPlan);
	// Free during beta (trial rollout off): no upgrade or Lifetime pitch in the
	// menu. Payers resolve as "subscription"/"license" and keep theirs.
	const showUpsell = verdict?.reason !== "beta";
	const creditsLeft = (() => {
		if (wallet) {
			return formatMicroUsd(wallet.balanceMicroUsd, wallet.currency);
		}
		if (creditsLoading) {
			return "Loading…";
		}
		if (creditsError) {
			return "Unavailable";
		}
		return "No workspace wallet";
	})();
	const resetDate = formatDate(
		orgBillingStatus?.subscription?.currentPeriodEnd
	);
	// Usage-remaining (credits + reset date) is a subscription concept — only
	// surface it for users who actually have a subscription.
	const hasSubscription = Boolean(
		organization && orgBillingStatus?.subscription
	);
	const openWeb = (path: string) => {
		openExternal(`${FRONTEND_URL.replace(TRAILING_SLASH_RE, "")}${path}`).catch(
			() => undefined
		);
	};
	const openPricing = () => openWeb("/pricing");
	const openLifetimeCheckout = async () => {
		try {
			const checkout = await stepUp.guard("billing", () =>
				settingsApi.billing.createLifetimeCheckout()
			);
			if (checkout === null) {
				return;
			}
			const { url } = checkout;
			await openExternal(url);
		} catch {
			toast.error({
				title: "Failed to start checkout",
				description: "Please try again.",
			});
		}
	};

	const plan = {
		creditsLeft,
		currentPlanLabel,
		hasSubscription,
		isLifetime,
		openLifetimeCheckout,
		openPricing,
		organization,
		resetDate,
		showUpsell,
		trialCountdown,
		upgradeTier,
	};
	const showCreate = !(botProduct || isMenubar);

	const footerRow = (
		<div
			className={
				isMenubar
					? "flex items-center gap-1 max-[360px]:gap-0.5"
					: "flex h-12 items-center gap-1"
			}
		>
			{showUser && (
				<HideChromeContextMenu
					label="account"
					onHide={onHideChrome ? () => onHideChrome("user") : undefined}
				>
					<div className={isMenubar ? "min-w-0" : "min-w-0 flex-1"}>
						<DropdownMenu
							onOpenChange={(open, eventDetails) => {
								if (!open && eventDetails.reason === "escape-key") {
									requestAnimationFrame(() =>
										userMenuTriggerRef.current?.focus({
											preventScroll: true,
										})
									);
								}
							}}
						>
							<DropdownMenuTrigger
								render={
									<Button
										appearance={
											isMenubar
												? "account-menu-menubar"
												: "account-menu-sidebar"
										}
										aria-label={isMenubar ? "Account" : undefined}
										className={
											isMenubar
												? undefined
												: "h-8 rounded-lg px-2 hover:bg-sidebar-accent/60 hover:duration-0"
										}
										ref={userMenuTriggerRef}
										type="button"
										variant="ghost"
									/>
								}
							>
								<div className="relative shrink-0">
									<Avatar className={isMenubar ? "size-4" : "size-6"}>
										<AvatarImage
											alt={user?.name ?? ""}
											src={user?.image ?? undefined}
										/>
										<AvatarFallback
											appearance="artwork"
											className="overflow-hidden"
										>
											<DitherAvatar
												className="size-full"
												name={ditherAvatarSeed({
													id: user?.id,
													email: user?.email,
													name: user?.name,
												})}
											/>
										</AvatarFallback>
									</Avatar>
									{/* Availability is this 6px dot only; the status itself is
											    chosen from the menu's "Online status" row. */}
									<AgentAvailabilityDot
										className={
											isMenubar
												? "absolute -right-0.5 -bottom-0.5 size-2 border border-transparent"
												: "absolute -right-px -bottom-px size-1.5 ring-2 ring-sidebar"
										}
										status={availability.status}
									/>
								</div>
								{!isMenubar && (
									<ButtonLabel className="flex-1 font-normal text-sm">
										{user?.name ?? "Account"}
									</ButtonLabel>
								)}
							</DropdownMenuTrigger>
							<NavUserAccountMenuContent
								availability={availability}
								botProduct={botProduct}
								handleSignOut={handleSignOut}
								isMenubar={isMenubar}
								openSettings={openSettings}
								openWeb={openWeb}
								plan={plan}
								profilePath={profilePath}
								surface={surface}
								user={user}
							/>
						</DropdownMenu>
					</div>
				</HideChromeContextMenu>
			)}

			<div
				className={
					isMenubar
						? "flex items-center gap-1 max-[360px]:gap-0.5"
						: "ml-auto flex shrink-0 items-center gap-1"
				}
			>
				{showDownloads && (isMenubar || downloadsActive) && (
					<HideChromeContextMenu
						label="downloads"
						onHide={onHideChrome ? () => onHideChrome("downloads") : undefined}
					>
						<DownloadCenter placement={isMenubar ? "menubar" : "sidebar"} />
					</HideChromeContextMenu>
				)}
				{showNotifications && (
					<HideChromeContextMenu
						label="inbox"
						onHide={
							showInbox && onHideChrome
								? () => onHideChrome("inbox")
								: undefined
						}
					>
						<InboxCenter
							layout={notificationLayout}
							placement={isMenubar ? "menubar" : "sidebar"}
							showAnnouncements={
								notificationLayout !== "split" && showAnnouncements
							}
							showInbox={showInbox}
						/>
					</HideChromeContextMenu>
				)}
			</div>
		</div>
	);

	return (
		<SidebarMenu
			className={isMenubar ? "w-auto flex-row items-center" : undefined}
			data-testid={isMenubar ? "ryu-os-user-navigation" : undefined}
			spacing={isMenubar ? "menubar" : "default"}
		>
			<SidebarMenuItem className={isMenubar ? "w-auto" : undefined}>
				{showCreate ? <CreateMenuHost>{footerRow}</CreateMenuHost> : footerRow}
			</SidebarMenuItem>
			{stepUp.dialog}
		</SidebarMenu>
	);
}
