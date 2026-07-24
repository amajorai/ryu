import {
	Add01Icon,
	ArrowUpRight01Icon,
	InboxIcon,
	Logout01Icon,
	PieChartIcon,
	Settings01Icon,
	Tick02Icon,
	UserGroupIcon,
	UserSwitchIcon,
	ViewOffSlashIcon,
	Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar";
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
} from "@ryu/ui/components/dropdown-menu";
import { PlanBadge, type PlanTier } from "@ryu/ui/components/plan-badge";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthContext } from "@/contexts/auth-context.tsx";
import {
	BACKEND_URL,
	FRONTEND_URL,
	getActiveUserId,
	listAccounts,
	type StoredAccount,
	signOutAccount,
	switchAccount,
	useSession,
} from "@/lib/auth-client.ts";
import { addAccountViaDeviceAuth } from "@/lib/oauth.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { BuildBadge } from "./BuildBadge.tsx";

const TRAILING_SLASH_RE = /\/$/;

import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useQuests } from "@/src/hooks/useQuests.ts";
import { fetchEntitlementStatus } from "@/src/lib/api/billing.ts";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { useAppStore } from "../../store/useAppStore.ts";
import { DownloadCenter } from "../downloads/DownloadCenter.tsx";
import { SettingsDialog } from "../settings/SettingsDialog.tsx";
import { UpdatesSubmenu } from "./UpdatesSubmenu.tsx";

type FooterChromeKey = "inbox" | "user" | "downloads" | "settings";

/**
 * The plan tier to badge from the entitlement verdict. During the free beta
 * `verdict.plan` is null while `proUnlocked` is true, so we fall back to "pro" —
 * every entitled user wears the Pro mark. A real paid subscription resolves the
 * actual tier (pro/max/teams) on `verdict.plan` instead.
 */
function entitlementBadgeTier(
	verdict: { plan: PlanTier | null; proUnlocked: boolean } | null
): PlanTier | null {
	if (verdict?.plan) {
		return verdict.plan;
	}
	return verdict?.proUnlocked ? "pro" : null;
}

const PLAN_LABELS: Record<string, string> = {
	"desktop-license": "Ryu Desktop",
	pro: "Ryu Pro",
	max: "Ryu Max",
	teams: "Ryu Teams",
};

function planLabel(
	plan: string | null | undefined,
	proUnlocked: boolean
): string {
	if (plan) {
		return PLAN_LABELS[plan] ?? plan;
	}
	return proUnlocked ? "Trial" : "Free";
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
// Pro, Pro/Lifetime → Max, Max → Teams, Teams → nothing (top of the ladder).
// Trial resolves currentPlan to null (proUnlocked, plan null), so it falls to
// the "Upgrade to Pro" default — the conversion pitch the trial should push.
function nextTierLabel(plan: string | null | undefined): string | null {
	if (plan === "teams") {
		return null;
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
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function InboxBadge({ count }: { count: number }) {
	const open = count > 0;
	return (
		<span
			aria-hidden={!open}
			className="t-badge -top-0.5 -right-0.5"
			data-open={open}
		>
			<span className="t-badge-dot flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-medium text-[10px] text-primary-foreground tabular-nums">
				{count > 9 ? "9+" : count}
			</span>
		</span>
	);
}

// Quick-list inbox: a popover preview of everything awaiting a decision —
// pending approvals plus task completions the quest engine flagged — with an
// "Open inbox" action that jumps to the full tab. Clicking any row also opens
// the full inbox; the popover is controlled so those clicks dismiss it.
function InboxCenter() {
	const { openTab } = useTabsContext();
	const approvals = useApprovals();
	const quests = useQuests();
	const [open, setOpen] = useState(false);
	const pending = approvals.approvals.filter((a) => a.status === "pending");
	// Open quests carrying a pending check-off suggestion (mirrors InboxPage).
	const taskSuggestions = quests.quests.filter(
		(q) => q.status === "open" && q.suggestion
	);
	const pendingCount = pending.length + taskSuggestions.length;

	const openInbox = () => {
		setOpen(false);
		openTab("/inbox");
	};

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							aria-label="Inbox"
							className="gooey-tap relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<HugeiconsIcon icon={InboxIcon} size={15} />
							<InboxBadge count={pendingCount} />
						</PopoverTrigger>
					}
				/>
				<TooltipContent>Inbox</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-80 gap-0 p-0" side="top">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="font-semibold text-sm">Inbox</span>
					{pendingCount > 0 && (
						<span className="text-muted-foreground text-xs">
							{pendingCount} pending
						</span>
					)}
				</div>
				{pendingCount > 0 ? (
					<div className="max-h-80 divide-y overflow-y-auto">
						{pending.slice(0, 8).map((approval) => (
							<button
								className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-muted"
								key={approval.id}
								onClick={openInbox}
								type="button"
							>
								<span className="truncate font-medium text-sm">
									{approval.title}
								</span>
								{approval.summary && (
									<span className="truncate text-muted-foreground text-xs">
										{approval.summary}
									</span>
								)}
							</button>
						))}
						{taskSuggestions.slice(0, 8).map((quest) => (
							<button
								className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-muted"
								key={quest.id}
								onClick={openInbox}
								type="button"
							>
								<span className="truncate font-medium text-sm">
									Finished “{quest.title}”?
								</span>
								{quest.suggestion?.reason && (
									<span className="truncate text-muted-foreground text-xs">
										{quest.suggestion.reason}
									</span>
								)}
							</button>
						))}
					</div>
				) : (
					<div className="px-3 py-6 text-center text-muted-foreground text-xs">
						Nothing needs your attention
					</div>
				)}
				<div className="border-t p-1">
					<button
						className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
						onClick={openInbox}
						type="button"
					>
						Open inbox
						<HugeiconsIcon icon={ArrowUpRight01Icon} size={14} />
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

// Notion-style account switcher: lists every signed-in account (avatar +
// name/email, a check on the active one), switches on click, adds another
// account via the existing device-auth flow, and signs an account out. Tokens
// stay local (the vault in auth-client); this only ever renders the safe fields.
function AccountSwitcher() {
	const [accounts, setAccounts] = useState<StoredAccount[]>(() =>
		listAccounts()
	);
	const [activeId, setActiveId] = useState<string | null>(() =>
		getActiveUserId()
	);
	const [adding, setAdding] = useState(false);

	const refresh = () => {
		setAccounts(listAccounts());
		setActiveId(getActiveUserId());
	};

	const handleSwitch = async (userId: string) => {
		if (userId === activeId) {
			return;
		}
		await switchAccount(userId);
		// Reload so the whole app re-hydrates (session, entitlements, wallet) under
		// the newly active account's bearer token.
		window.location.reload();
	};

	const handleSignOutAccount = async (
		event: React.MouseEvent,
		account: StoredAccount
	) => {
		// Keep the menu open and prevent the row's switch handler from firing.
		event.preventDefault();
		event.stopPropagation();
		const wasActive = account.userId === activeId;
		await signOutAccount(account.userId);
		if (wasActive) {
			// Active account removed: reload to re-hydrate as the fallback account
			// (or the logged-out state when none remain).
			window.location.reload();
			return;
		}
		refresh();
	};

	const handleAddAccount = () => {
		if (adding) {
			return;
		}
		setAdding(true);
		addAccountViaDeviceAuth(BACKEND_URL, {
			onCode: (info) => {
				openExternal(info.verificationUriComplete).catch(() => undefined);
				toast.show({
					title: "Finish signing in",
					description: `Approve in your browser${
						info.userCode ? ` (code ${info.userCode})` : ""
					} to add the account.`,
				});
			},
			onAdded: () => {
				setAdding(false);
				toast.success("Account added");
				// The new account is now active — reload to switch into it.
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

	const activeAccount = accounts.find((a) => a.userId === activeId);
	const activeLabel =
		activeAccount?.name || activeAccount?.email || "Switch account";

	const accountList = (
		<>
			{accounts.map((account) => {
				const isActive = account.userId === activeId;
				const label = account.name || account.email || "Account";
				return (
					<DropdownMenuItem
						key={account.userId}
						onClick={() => handleSwitch(account.userId)}
					>
						<Avatar className="mr-2 size-6 shrink-0 rounded-full">
							<AvatarImage
								alt={account.name ?? account.email}
								src={account.image ?? undefined}
							/>
							<AvatarFallback className="overflow-hidden rounded-full bg-transparent p-0">
								<DitherAvatar
									className="size-full"
									name={account.userId ?? account.email ?? "ryu"}
								/>
							</AvatarFallback>
						</Avatar>
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate font-medium text-sm">{label}</span>
							{account.email && account.email !== label ? (
								<span className="truncate text-[11px] text-muted-foreground">
									{account.email}
								</span>
							) : null}
						</span>
						{isActive ? (
							<HugeiconsIcon
								className="ml-2 size-4 shrink-0 text-primary"
								icon={Tick02Icon}
							/>
						) : null}
						<button
							aria-label={`Sign out ${label}`}
							className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							onClick={(event) => handleSignOutAccount(event, account)}
							title="Sign out"
							type="button"
						>
							<HugeiconsIcon icon={Logout01Icon} size={14} />
						</button>
					</DropdownMenuItem>
				);
			})}
			<DropdownMenuItem
				onClick={(event: React.MouseEvent) => {
					// Keep the menu logic simple: don't let the click close before the
					// flow starts (device auth opens the browser).
					event.preventDefault();
					handleAddAccount();
				}}
			>
				{adding ? (
					<Spinner className="mr-2 size-4" />
				) : (
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
				)}
				Add account
			</DropdownMenuItem>
		</>
	);

	// A single account needs no switcher list, but keep the entry so the user can
	// still add another account from here.
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="mr-2 size-4" icon={UserSwitchIcon} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate">Switch account</span>
					{activeAccount ? (
						<span className="truncate text-[11px] text-muted-foreground">
							{activeLabel}
						</span>
					) : null}
				</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="min-w-56">
				{accountList}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export function NavUser({
	hiddenChrome,
	onHideChrome,
}: {
	hiddenChrome: Set<string>;
	onHideChrome: (key: FooterChromeKey) => void;
}) {
	const settingsOpen = useSettingsDialog((s) => s.open);
	const settingsSection = useSettingsDialog((s) => s.section);
	const setSettingsOpen = useSettingsDialog((s) => s.setOpen);
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const { data: session, isPending } = useSession();
	const { verdict } = useEntitlementContext();
	const { openTab } = useTabsContext();
	const badgePlan = entitlementBadgeTier(verdict);
	const {
		wallet,
		entitlement,
		loading: creditsLoading,
		error: creditsError,
	} = useCreditsWallet();
	const { data: billingStatus } = useQuery({
		queryKey: ["billing-status-nav"],
		queryFn: fetchEntitlementStatus,
	});
	const { isSigningOut, handleSignOut } = useAuthContext();
	const isAuthenticated = useAppStore((s) => s.isAuthenticated);
	const oidcUser = useAppStore((s) => s.oidcUser);
	const sessionUser = session?.user;
	const user =
		sessionUser ??
		(oidcUser
			? {
					name: oidcUser.name ?? null,
					email: oidcUser.email ?? null,
					image: oidcUser.picture ?? null,
				}
			: null);

	if (isPending) {
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

	const showInbox = !hiddenChrome.has("inbox");
	const showUser = !hiddenChrome.has("user");
	const showDownloads = !hiddenChrome.has("downloads");
	const showSettings = !hiddenChrome.has("settings");
	if (!(showInbox || showUser || showDownloads || showSettings)) {
		return null;
	}

	const currentPlan = entitlement?.plan ?? verdict?.plan ?? billingStatus?.plan;
	const currentPlanLabel = planLabel(
		currentPlan,
		Boolean(verdict?.proUnlocked)
	);
	const trialCountdown = showTrialCountdown(verdict)
		? trialDaysLabel(verdict.daysLeftInTrial)
		: null;
	const upgradeLabel = nextTierLabel(currentPlan);
	const creditsLeft = (() => {
		if (wallet) {
			return formatMicroUsd(wallet.balanceMicroUsd, wallet.currency);
		}
		if (creditsLoading) {
			return "Loading...";
		}
		if (creditsError) {
			return "Unavailable";
		}
		return "No workspace wallet";
	})();
	const resetDate = formatDate(billingStatus?.subscription?.currentPeriodEnd);
	// Usage-remaining (credits + reset date) is a subscription concept — only
	// surface it for users who actually have a subscription.
	const hasSubscription = Boolean(billingStatus?.subscription);
	const openPricing = () => {
		openExternal(
			`${FRONTEND_URL.replace(TRAILING_SLASH_RE, "")}/pricing`
		).catch(() => undefined);
	};

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<div className="flex items-center px-1">
					{showUser && (
						<ContextMenu>
							<ContextMenuTrigger>
								<div className="min-w-0 max-w-[160px]">
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<button
													className="flex w-full items-center gap-2 rounded-xl py-1.5 pr-2 pl-1 text-left text-sm transition-colors hover:bg-muted"
													title={
														trialCountdown
															? `${trialCountdown} in trial`
															: undefined
													}
													type="button"
												/>
											}
										>
											<Avatar className="size-6 shrink-0 rounded-full">
												<AvatarImage
													alt={user?.name ?? ""}
													src={user?.image ?? undefined}
												/>
												<AvatarFallback className="overflow-hidden rounded-full bg-transparent p-0">
													<DitherAvatar
														className="size-full"
														name={user?.email ?? user?.name ?? "ryu"}
													/>
												</AvatarFallback>
											</Avatar>
											<span className="min-w-0 flex-1">
												<span className="flex min-w-0 items-center gap-1.5">
													<span className="truncate font-medium text-sm">
														{user?.name ?? "Account"}
													</span>
													<PlanBadge plan={badgePlan} />
												</span>
												{trialCountdown ? (
													<span className="block truncate text-[10px] text-muted-foreground tabular-nums">
														{trialCountdown} in trial
													</span>
												) : null}
											</span>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="end"
											className="min-w-56"
											side="bottom"
											sideOffset={4}
										>
											<AccountSwitcher />
											<DropdownMenuSeparator />
											<DropdownMenuGroup>
												<DropdownMenuItem onClick={() => openTab("/profile")}>
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={UserGroupIcon}
													/>
													Profile
												</DropdownMenuItem>
												<DropdownMenuItem onClick={() => openSettings()}>
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={Settings01Icon}
													/>
													Settings
												</DropdownMenuItem>
												<UpdatesSubmenu />
											</DropdownMenuGroup>
											<DropdownMenuSeparator />
											<DropdownMenuGroup>
												<DropdownMenuItem disabled>
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={Wallet01Icon}
													/>
													<span className="flex-1">Plan</span>
													<span className="text-right text-muted-foreground">
														{currentPlanLabel}
														{trialCountdown ? (
															<span className="block text-[11px] tabular-nums">
																{trialCountdown}
															</span>
														) : null}
													</span>
												</DropdownMenuItem>
												{hasSubscription && (
													<DropdownMenuSub>
														<DropdownMenuSubTrigger>
															<HugeiconsIcon
																className="mr-2 size-4"
																icon={PieChartIcon}
															/>
															Usage remaining
														</DropdownMenuSubTrigger>
														<DropdownMenuSubContent className="min-w-64">
															<div className="space-y-3 px-3 py-2">
																<div>
																	<p className="text-muted-foreground text-xs">
																		Credits left for workspace
																	</p>
																	<p className="font-semibold text-sm">
																		{creditsLeft}
																	</p>
																</div>
																<div>
																	<p className="text-muted-foreground text-xs">
																		Reset date
																	</p>
																	<p className="font-semibold text-sm">
																		{resetDate}
																	</p>
																</div>
															</div>
														</DropdownMenuSubContent>
													</DropdownMenuSub>
												)}
												<DropdownMenuItem onClick={openPricing}>
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={
															upgradeLabel ? ArrowUpRight01Icon : Wallet01Icon
														}
													/>
													{upgradeLabel ?? "See all plans"}
												</DropdownMenuItem>
											</DropdownMenuGroup>
											<DropdownMenuItem
												disabled={isSigningOut}
												onClick={handleSignOut}
											>
												{isSigningOut ? (
													<Spinner className="mr-2 size-4" />
												) : (
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={Logout01Icon}
													/>
												)}
												Log out
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onClick={() => onHideChrome("user")}>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={ViewOffSlashIcon}
									/>
									Hide account
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					)}
					{/* Build/profile badge ("Dev" / channel) — self-hides on a plain
					    release build. Sits beside the account button. */}
					<BuildBadge className="ml-1.5" />
					<div className="ml-auto flex items-center gap-0.5">
						{/* Create menu ("+") temporarily hidden per request. Restore by
						    re-adding the CreateMenu import and <CreateMenu /> here. */}
						{showInbox && (
							<ContextMenu>
								<ContextMenuTrigger>
									<InboxCenter />
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuItem onClick={() => onHideChrome("inbox")}>
										<HugeiconsIcon
											className="mr-2 size-4"
											icon={ViewOffSlashIcon}
										/>
										Hide inbox
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						)}
						{showDownloads && (
							<ContextMenu>
								<ContextMenuTrigger>
									<DownloadCenter />
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuItem onClick={() => onHideChrome("downloads")}>
										<HugeiconsIcon
											className="mr-2 size-4"
											icon={ViewOffSlashIcon}
										/>
										Hide downloads
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						)}
						{showSettings && (
							<ContextMenu>
								<ContextMenuTrigger>
									<Tooltip>
										<TooltipTrigger
											render={
												<button
													aria-label="Settings"
													className="gooey-tap flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
													onClick={() => openSettings()}
													type="button"
												>
													<HugeiconsIcon icon={Settings01Icon} size={15} />
												</button>
											}
										/>
										<TooltipContent>Settings</TooltipContent>
									</Tooltip>
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuItem onClick={() => onHideChrome("settings")}>
										<HugeiconsIcon
											className="mr-2 size-4"
											icon={ViewOffSlashIcon}
										/>
										Hide settings
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						)}
					</div>
				</div>
				<SettingsDialog
					defaultSection={settingsSection}
					onOpenChange={setSettingsOpen}
					open={settingsOpen}
				/>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
