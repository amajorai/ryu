import {
	AgentAvailabilityDot,
	agentAvailabilityLabel,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { settingsApi, useSubscription } from "@ryu/settings";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { NavBeamCta } from "@ryu/ui/components/border-beam.tsx";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import { ClassicThemeIcon } from "@ryu/ui/components/classic-theme-icon.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { GetRyuAppsSubmenu } from "@ryu/ui/components/get-ryu-apps-submenu.tsx";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	INVITE_FRIEND_NAV_ITEM,
	JOIN_DISCORD_NAV_ITEM,
} from "@ryu/ui/lib/referral-navigation.ts";
import { hasMobileStoreListing } from "@ryu/ui/lib/ryu-app-surfaces.ts";
import {
	ArrowUp,
	ArrowUpRight,
	Check,
	CreditCard,
	Database,
	EyeOff,
	Gift,
	KeyRound,
	Laptop,
	LogOut,
	MessageCircle,
	Moon,
	MoreHorizontal,
	PieChart,
	Plus,
	ScrollText,
	Settings,
	Shield,
	Sun,
	User,
} from "lucide-react";
import { useTheme } from "next-themes";
import { type ReactNode, useRef, useState } from "react";
import { z } from "zod";
import { useAuthContext } from "@/contexts/auth-context.tsx";
import {
	BACKEND_URL,
	FRONTEND_URL,
	getActiveUserId,
	listAccounts,
	signOutAccount,
	switchAccount,
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
import { ISLAND_ENABLED } from "@/src/lib/island-availability.ts";
import type { NotificationLayout } from "@/src/lib/notification-layout.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import { formatDate as formatDateInZone } from "@/src/lib/timezone.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
// Keep the shared desktop OAuth implementation on the extension build path;
// the extension swaps only its auth-client module, not this device-flow API.
import {
	addAccountViaDeviceAuth,
	localizeVerificationUrl,
} from "../../../lib/oauth.ts";
import { useAppStore } from "../../store/useAppStore.ts";
import { DownloadCenter } from "../downloads/DownloadCenter.tsx";
import { InboxCenter } from "../inbox/InboxCenter.tsx";
import {
	preloadSettingsDialog,
	SettingsDialog,
} from "../settings/LazySettingsDialog.tsx";
import {
	AvailabilityOptions,
	AvailabilityStatusButton,
	AvailabilitySubmenu,
} from "./AvailabilityMenu.tsx";
import { BuildBadge } from "./BuildBadge.tsx";
import { CreateMenu } from "./CreateMenu.tsx";
import { HelpSubmenu } from "./HelpSubmenu.tsx";
import { IslandVisibilityMenuItem } from "./IslandVisibilityMenuItem.tsx";

const TRAILING_SLASH_RE = /\/$/;
// Vite inlines these at build time. Until one names a store listing,
// `/download#mobile` has nothing to install, so "Get Ryu apps" leaves Mobile out.
const MOBILE_APP_LISTED = hasMobileStoreListing(
	import.meta.env.VITE_IOS_APP_URL,
	import.meta.env.VITE_ANDROID_APP_URL
);
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

function HideChromeContextMenu({
	children,
	label,
	onHide,
}: {
	children: ReactNode;
	label: string;
	onHide?: () => void;
}) {
	if (!onHide) {
		return children;
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={onHide}>
					<EyeOff className="mr-2 size-4" />
					Hide {label}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

interface DesktopWebAccountLinksProps {
	botProduct?: boolean;
	onOpenWeb: (path: string) => void;
	profilePath: string;
}

/** The account links that leave the desktop shell for the web account surface. */
export function DesktopWebAccountLinks({
	botProduct = false,
	onOpenWeb,
	profilePath,
}: DesktopWebAccountLinksProps) {
	if (botProduct) {
		return (
			<>
				<DropdownMenuItem onClick={() => onOpenWeb("/settings")}>
					<User className="mr-2 size-4" />
					Account
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onOpenWeb("/organizations")}>
					<User className="mr-2 size-4" />
					Organizations
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onOpenWeb(JOIN_DISCORD_NAV_ITEM.path)}>
					<MessageCircle className="mr-2 size-4" />
					{JOIN_DISCORD_NAV_ITEM.label}
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onOpenWeb("/download")}>
					<Laptop className="mr-2 size-4" />
					Download Ryu Build
				</DropdownMenuItem>
			</>
		);
	}
	return (
		<>
			<DropdownMenuItem onClick={() => onOpenWeb(profilePath)}>
				<User className="mr-2 size-4" />
				Profile
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb("/organizations")}>
				<User className="mr-2 size-4" />
				Organizations
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb(INVITE_FRIEND_NAV_ITEM.path)}>
				<Gift className="mr-2 size-4" />
				{INVITE_FRIEND_NAV_ITEM.label}
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb(JOIN_DISCORD_NAV_ITEM.path)}>
				<MessageCircle className="mr-2 size-4" />
				{JOIN_DISCORD_NAV_ITEM.label}
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb("/settings")}>
				<Settings className="mr-2 size-4" />
				Account
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => onOpenWeb("/api-keys")}>
				<KeyRound className="mr-2 size-4" />
				Personal access tokens
			</DropdownMenuItem>
		</>
	);
}

/** The desktop user-nav theme submenu, matching the website's icon treatment. */
export function DesktopThemeSubmenu() {
	const { setTheme } = useTheme();

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<ClassicThemeIcon className="size-4 shrink-0" />
				<span>Theme</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuItem onClick={() => setTheme("light")}>
					<Sun className="h-4 w-4" />
					Light
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setTheme("dark")}>
					<Moon className="h-4 w-4" />
					Dark
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setTheme("system")}>
					<Laptop className="h-4 w-4" />
					System
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

const PLAN_LABELS = new Map([
	["desktop-license", "Ryu Desktop"],
	["marketplace-membership", "A Major Pass"],
	["pro", "Ryu Pro"],
	["plus", "Ryu Plus"],
	["max", "Ryu Max"],
	["teams", "Ryu Teams"],
	["teams-lite", "Ryu Teams Lite"],
]);

function planLabel(plan: string | null | undefined, trialing: boolean): string {
	if (plan) {
		return PLAN_LABELS.get(plan) ?? plan;
	}
	// Only a running trial is labelled "Trial"; beta (trial rollout off) is Free.
	return trialing ? "Trial" : "Free";
}

function trialDaysLabel(days: number): string {
	return `${days} day${days === 1 ? "" : "s"} left`;
}

function showTrialCountdown(
	verdict: { reason: string; daysLeftInTrial: number } | null | undefined
): verdict is { reason: "trial"; daysLeftInTrial: number } {
	return verdict?.reason === "trial" && verdict.daysLeftInTrial > 0;
}

// The single next-tier upsell shown in the account menu. Ladder: Free/Trial →
// Pro, Plus → Pro, Pro/Lifetime → Max, Max → Teams, Teams → nothing (top of
// the public ladder). Plus is private, so Free/Trial still defaults to Pro.
// Trial resolves currentPlan to null (proUnlocked, plan null), so it falls to
// the "Upgrade to Pro" default — the conversion pitch the trial should push.
function nextTierLabel(plan: string | null | undefined): string | null {
	if (plan === "teams") {
		return null;
	}
	if (plan === "teams-lite") {
		return "Upgrade to Teams";
	}
	if (plan === "plus") {
		return "Upgrade to Pro";
	}
	if (plan === "max") {
		return "Upgrade to Teams";
	}
	if (plan === "pro" || plan === "desktop-license") {
		return "Upgrade to Max";
	}
	return "Upgrade to Pro";
}

function formatDate(value: string | null | undefined): string {
	if (!value) {
		return "Not scheduled";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "Not scheduled";
	}
	return formatDateInZone(date, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

// Notion-style account switcher: lists every signed-in account (avatar +
// name/email, a check on the active one), switches on click, adds another
// account via the existing device-auth flow, and signs an account out. Tokens
// stay local (the vault in auth-client); this only ever renders the safe fields.
type AccountView = ReturnType<typeof listAccounts>[number];

export function AccountList({
	activeUser,
	onSignOutAll,
}: {
	activeUser: {
		id?: string;
		name?: string | null;
		email?: string | null;
		image?: string | null;
	} | null;
	onSignOutAll: () => void;
}) {
	const [accounts, setAccounts] = useState<AccountView[]>(() => listAccounts());
	const [activeId, setActiveId] = useState<string | null>(() =>
		getActiveUserId()
	);
	const [adding, setAdding] = useState(false);
	const [pendingSignOut, setPendingSignOut] = useState<AccountView | null>(
		null
	);
	const [signingOut, setSigningOut] = useState(false);
	const activeAccount = accounts.find((account) => account.userId === activeId);
	const activeLabel =
		(activeAccount?.isAnonymous ? "Guest" : null) ||
		activeAccount?.name ||
		activeAccount?.email ||
		activeUser?.name ||
		activeUser?.email ||
		"Account";

	const refresh = () => {
		setAccounts(listAccounts());
		setActiveId(getActiveUserId());
	};

	const handleSwitch = async (userId: string) => {
		if (userId === activeId) {
			return;
		}
		await switchAccount(userId);
		window.location.reload();
	};

	const handleSignOutAccount = (
		event: React.MouseEvent,
		account: AccountView
	) => {
		event.preventDefault();
		event.stopPropagation();
		setPendingSignOut(account);
	};

	const confirmSignOut = async () => {
		if (!pendingSignOut || signingOut) {
			return;
		}
		setSigningOut(true);
		try {
			const wasActive = pendingSignOut.userId === activeId;
			await signOutAccount(pendingSignOut.userId);
			setPendingSignOut(null);
			if (wasActive) {
				window.location.reload();
				return;
			}
			refresh();
		} catch (error) {
			toast.error({
				title: "Couldn't sign out",
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		} finally {
			setSigningOut(false);
		}
	};

	const handleAddAccount = () => {
		if (adding) {
			return;
		}
		setAdding(true);
		addAccountViaDeviceAuth(BACKEND_URL, {
			onCode: (info) => {
				openExternal(
					localizeVerificationUrl(info.verificationUriComplete)
				).catch(() => undefined);
				toast.show({
					title: "Finish signing in",
					description: (
						<div className="grid gap-2">
							<p>Approve in your browser to add the account.</p>
							{info.userCode ? (
								<OTPCodeDisplay
									aria-label="Device sign-in code"
									code={info.userCode}
									size="compact"
								/>
							) : null}
						</div>
					),
				});
			},
			onAdded: () => {
				setAdding(false);
				toast.success("Account added");
				window.location.reload();
			},
			onError: (err) => {
				setAdding(false);
				toast.error({
					title: "Couldn't add account",
					description: err.message,
				});
			},
		});
	};

	return (
		<>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger className="max-w-full" spacing="comfortable">
					<Avatar className="size-6 shrink-0">
						<AvatarImage
							alt={activeLabel}
							src={activeAccount?.image ?? activeUser?.image ?? undefined}
						/>
						<AvatarFallback appearance="artwork" className="overflow-hidden">
							<DitherAvatar
								className="size-full"
								name={ditherAvatarSeed({
									id: activeId ?? activeUser?.id,
									email: activeAccount?.email ?? activeUser?.email,
									name: activeAccount?.name ?? activeUser?.name,
								})}
							/>
						</AvatarFallback>
					</Avatar>
					<span className="min-w-0 flex-1 truncate">{activeLabel}</span>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="min-w-64">
					<DropdownMenuGroup>
						{accounts.map((account) => {
							const isActive = account.userId === activeId;
							const label = account.isAnonymous
								? "Guest"
								: account.name || account.email || "Account";
							return (
								<DropdownMenuItem
									className="group/item"
									closeOnClick={false}
									key={account.userId}
									onClick={() => handleSwitch(account.userId)}
									spacing="comfortable"
								>
									<Avatar className="size-6 shrink-0">
										<AvatarImage
											alt={account.name ?? account.email}
											src={account.image ?? undefined}
										/>
										<AvatarFallback
											appearance="artwork"
											className="overflow-hidden"
										>
											<DitherAvatar
												className="size-full"
												name={ditherAvatarSeed({
													id: account.userId,
													email: account.email,
													name: account.name,
												})}
											/>
										</AvatarFallback>
									</Avatar>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate font-medium text-sm">
											{label}
										</span>
										{account.email && account.email !== label ? (
											<span
												className="type-caption truncate text-muted-foreground"
												title={account.email}
											>
												{account.email}
											</span>
										) : null}
									</span>
									<span className="relative ml-1 flex size-5 shrink-0 items-center justify-center">
										{isActive ? (
											<span className="absolute transition-[opacity,scale] duration-150 group-hover/item:scale-50 group-hover/item:opacity-0 motion-reduce:transition-opacity">
												<Check className="size-4 text-primary" />
											</span>
										) : null}
										<button
											aria-label={`Sign out ${label}`}
											className="absolute flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,scale,color,background-color] duration-150 hover:bg-accent hover:text-status-destructive focus-visible:scale-100 focus-visible:opacity-100 group-hover/item:scale-100 group-hover/item:opacity-100"
											onClick={(event) => handleSignOutAccount(event, account)}
											type="button"
										>
											<LogOut className="h-3.5 w-3.5" />
										</button>
									</span>
								</DropdownMenuItem>
							);
						})}
						<DropdownMenuItem
							onClick={(event: React.MouseEvent) => {
								event.preventDefault();
								handleAddAccount();
							}}
						>
							{adding ? (
								<Spinner className="mr-2 size-4" />
							) : (
								<Plus className="mr-2 size-4" />
							)}
							Add account
						</DropdownMenuItem>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={onSignOutAll} variant="destructive">
						<LogOut className="mr-2 size-4" />
						Log out of all accounts
					</DropdownMenuItem>
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<AlertDialog
				onOpenChange={(open) => {
					if (!(open || signingOut)) {
						setPendingSignOut(null);
					}
				}}
				open={pendingSignOut !== null}
			>
				<AlertDialogContent className="max-w-md">
					<AlertDialogHeader>
						<AlertDialogTitle>Log out of this account?</AlertDialogTitle>
						<AlertDialogDescription>
							You&apos;ll need to sign in again to use this account on this
							device.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{pendingSignOut ? (
						<div className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5">
							<Avatar className="size-9 shrink-0">
								<AvatarImage
									alt={pendingSignOut.name ?? pendingSignOut.email}
									src={pendingSignOut.image ?? undefined}
								/>
								<AvatarFallback
									appearance="artwork"
									className="overflow-hidden"
								>
									<DitherAvatar
										className="size-full"
										name={ditherAvatarSeed({
											id: pendingSignOut.userId,
											email: pendingSignOut.email,
											name: pendingSignOut.name,
										})}
									/>
								</AvatarFallback>
							</Avatar>
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-medium text-sm">
									{pendingSignOut.isAnonymous
										? "Guest"
										: pendingSignOut.name || pendingSignOut.email || "Account"}
								</span>
								<span
									className="truncate text-muted-foreground text-xs"
									title={pendingSignOut.email}
								>
									{pendingSignOut.email}
								</span>
							</span>
						</div>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={signingOut}
							onClick={confirmSignOut}
							variant="destructive"
						>
							{signingOut ? <Spinner className="size-4" /> : null}
							Log out
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

export function NavUser(props: NavUserProps) {
	const isMenubar = props.presentation === "menubar";
	const hiddenChrome =
		props.presentation === "menubar" ? EMPTY_HIDDEN_CHROME : props.hiddenChrome;
	const notificationLayout =
		props.presentation === "menubar" ? "unified" : props.notificationLayout;
	const onHideChrome =
		props.presentation === "menubar" ? undefined : props.onHideChrome;
	const botProduct = useProductMode() === "bot";
	const { surface } = useAppSurface();
	const { resolvedTheme } = useTheme();
	const stepUp = useStepUp();
	const beamTheme = resolvedTheme === "light" ? "light" : "dark";
	const settingsOpen = useSettingsDialog((s) => s.open);
	const settingsSection = useSettingsDialog((s) => s.section);
	const setSettingsOpen = useSettingsDialog((s) => s.setOpen);
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
		? trialDaysLabel(verdict.daysLeftInTrial)
		: null;
	const upgradeLabel = nextTierLabel(currentPlan);
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

	const upgradeItem = (
		<DropdownMenuItem onClick={openPricing}>
			{upgradeLabel ? (
				<ArrowUpRight className="mr-2 size-4" />
			) : (
				<CreditCard className="mr-2 size-4" />
			)}
			{upgradeLabel ?? "See all plans"}
		</DropdownMenuItem>
	);

	return (
		<SidebarMenu
			className={isMenubar ? "w-auto flex-row items-center" : undefined}
			data-testid={isMenubar ? "ryu-os-user-navigation" : undefined}
			spacing={isMenubar ? "menubar" : "default"}
		>
			<SidebarMenuItem className={isMenubar ? "w-auto" : undefined}>
				<div
					className={
						isMenubar
							? "flex items-center gap-1 max-[360px]:gap-0.5"
							: "flex items-center px-1"
					}
				>
					{showUser && (
						<HideChromeContextMenu
							label="account"
							onHide={onHideChrome ? () => onHideChrome("user") : undefined}
						>
							{/* Wider than the 160px it was: even a two-word name faded out
								    mid-surname, which read as broken rather than as clipped. No
								    min width — the row shrinks to fit, so a floor there only pads
								    the gap between the avatar and the name. */}
							<div className={isMenubar ? "min-w-0" : "min-w-0 max-w-[15rem]"}>
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
											<AgentAvailabilityDot
												className={
													isMenubar
														? "absolute -right-0.5 -bottom-0.5 size-2 border border-transparent"
														: "absolute right-0 bottom-0 size-2.5 ring-2 ring-sidebar"
												}
												status={availability.status}
											/>
										</div>
										{!isMenubar && (
											<ButtonLabel className="flex-1">
												{user?.name ?? "Account"}
											</ButtonLabel>
										)}
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="end"
										className="min-w-64"
										side="bottom"
										sideOffset={4}
									>
										{isMenubar && (
											<DropdownMenuSub>
												<DropdownMenuSubTrigger>
													<AgentAvailabilityDot
														className="mr-2"
														status={availability.status}
													/>
													Availability:{" "}
													{agentAvailabilityLabel(availability.status)}
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent className="min-w-60">
													<AvailabilityOptions availability={availability} />
												</DropdownMenuSubContent>
											</DropdownMenuSub>
										)}
										<DropdownMenuSeparator />
										<AccountList
											activeUser={user}
											onSignOutAll={handleSignOut}
										/>
										<DropdownMenuSeparator />
										<DropdownMenuGroup>
											{!isMenubar && <AvailabilitySubmenu />}
											<DesktopWebAccountLinks
												botProduct={botProduct}
												onOpenWeb={openWeb}
												profilePath={profilePath}
											/>
											{!botProduct && (
												<DropdownMenuItem
													onClick={() => openSettings()}
													onFocus={preloadSettingsDialog}
													onPointerEnter={preloadSettingsDialog}
												>
													<Settings className="mr-2 size-4" />
													Settings
												</DropdownMenuItem>
											)}
											{ISLAND_ENABLED ? <IslandVisibilityMenuItem /> : null}
											{/* # 0.1.0: Capture toggle disabled — restore with the User Nav control.
															<CaptureToggleMenuItem /> */}
											{/* The same tree runs as the native shell, as apps/webapp (and its
											    Telegram Mini App) in a browser tab, and as the extension
											    dashboard; never promote the host the user is already in. */}
											{!botProduct && (
												<GetRyuAppsSubmenu
													current={
														surface === "web" || surface === "telegram"
															? "web"
															: surface
													}
													mobileListed={MOBILE_APP_LISTED}
													onOpen={openWeb}
												/>
											)}
											<HelpSubmenu />
										</DropdownMenuGroup>
										<DesktopThemeSubmenu />
										<DropdownMenuSeparator />
										<DropdownMenuGroup>
											<DropdownMenuItem disabled>
												<CreditCard className="mr-2 size-4" />
												<span className="flex-1">
													{organization ? "Organization plan" : "Plan"}
												</span>
												<span className="text-right text-muted-foreground">
													{currentPlanLabel}
													{trialCountdown ? (
														<span className="type-caption block tabular-nums">
															{trialCountdown}
														</span>
													) : null}
												</span>
											</DropdownMenuItem>
											{hasSubscription && (
												<DropdownMenuSub>
													<DropdownMenuSubTrigger>
														<PieChart className="mr-2 size-4" />
														Usage remaining
													</DropdownMenuSubTrigger>
													<DropdownMenuSubContent className="min-w-64">
														<div className="space-y-3 px-3 py-2">
															<div>
																<p className="text-muted-foreground text-xs">
																	Credits left for organization
																</p>
																<p className="font-medium font-mono text-sm tabular-nums">
																	{creditsLeft}
																</p>
															</div>
															<div>
																<p className="text-muted-foreground text-xs">
																	Reset date
																</p>
																<p className="font-medium text-sm">
																	{resetDate}
																</p>
															</div>
														</div>
													</DropdownMenuSubContent>
												</DropdownMenuSub>
											)}
											{showUpsell &&
												(upgradeLabel === "Upgrade to Pro" ? (
													<NavBeamCta theme={beamTheme} variant="pulse">
														{upgradeItem}
													</NavBeamCta>
												) : (
													upgradeItem
												))}
											{showUpsell && !isLifetime && (
												<NavBeamCta theme={beamTheme} variant="rotate">
													<DropdownMenuItem onClick={openLifetimeCheckout}>
														<ArrowUp className="mr-2 size-4" />
														Get Lifetime Access
													</DropdownMenuItem>
												</NavBeamCta>
											)}
										</DropdownMenuGroup>
										<DropdownMenuSeparator />
										<DropdownMenuGroup>
											<DropdownMenuSub>
												<DropdownMenuSubTrigger>
													<MoreHorizontal className="mr-2 size-4" />
													More
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent className="min-w-52">
													<DropdownMenuItem onClick={() => openWeb("/terms")}>
														<ScrollText className="mr-2 size-4" />
														Terms of Service
													</DropdownMenuItem>
													<DropdownMenuItem onClick={() => openWeb("/privacy")}>
														<Shield className="mr-2 size-4" />
														Privacy
													</DropdownMenuItem>
													<DropdownMenuItem onClick={() => openWeb("/dpa")}>
														<Database className="mr-2 size-4" />
														Data Processing Agreement
													</DropdownMenuItem>
												</DropdownMenuSubContent>
											</DropdownMenuSub>
										</DropdownMenuGroup>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</HideChromeContextMenu>
					)}
					{showUser && !isMenubar && <AvailabilityStatusButton />}
					{!botProduct && <BuildBadge className="ml-1" />}

					<div
						className={
							isMenubar
								? "flex items-center gap-1 max-[360px]:gap-0.5"
								: "ml-auto flex items-center gap-0.5"
						}
					>
						{!(botProduct || isMenubar) && <CreateMenu />}
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
						{showDownloads && (
							<HideChromeContextMenu
								label="downloads"
								onHide={
									onHideChrome ? () => onHideChrome("downloads") : undefined
								}
							>
								<DownloadCenter placement={isMenubar ? "menubar" : "sidebar"} />
							</HideChromeContextMenu>
						)}
					</div>
				</div>
				{!botProduct && (
					<SettingsDialog
						defaultSection={settingsSection}
						onOpenChange={setSettingsOpen}
						open={settingsOpen}
					/>
				)}
			</SidebarMenuItem>
			{stepUp.dialog}
		</SidebarMenu>
	);
}
