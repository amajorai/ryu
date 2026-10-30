// The account switcher submenu in the account menu.

import {
	Add01Icon,
	Logout01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { type ReactNode, useState } from "react";
import {
	BACKEND_URL,
	getActiveUserId,
	listAccounts,
	signOutAccount,
	switchAccount,
} from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
// Keep the shared desktop OAuth implementation on the extension build path;
// the extension swaps only its auth-client module, not this device-flow API.
import {
	addAccountViaDeviceAuth,
	localizeVerificationUrl,
} from "../../../lib/oauth.ts";

// Notion-style account switcher: lists every signed-in account (avatar +
// name/email, a check on the active one), switches on click, adds another
// account via the existing device-auth flow, and signs an account out. Tokens
// stay local (the vault in auth-client); this only ever renders the safe fields.
type AccountView = ReturnType<typeof listAccounts>[number];

export function AccountList({
	accountItems,
	activeUser,
	onSignOutAll,
}: {
	/** Rows about the active account (profile, web settings), shown above sign-out. */
	accountItems?: ReactNode;
	activeUser: {
		id?: string;
		name?: string | null;
		email?: string | null;
		image?: string | null;
	} | null;
	onSignOutAll: () => void;
}) {
	const tl = useLiteralMessages();
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
										<span className="truncate text-sm">{label}</span>
										{account.email && account.email !== label ? (
											<span
												className="truncate text-muted-foreground text-xs"
												title={account.email}
											>
												{account.email}
											</span>
										) : null}
									</span>
									<span className="relative ml-1 flex size-5 shrink-0 items-center justify-center">
										{isActive ? (
											<span className="absolute transition-[opacity,scale] duration-150 group-hover/item:scale-50 group-hover/item:opacity-0 motion-reduce:transition-opacity">
												<HugeiconsIcon
													className="size-4 text-foreground"
													icon={Tick02Icon}
												/>
											</span>
										) : null}
										<button
											aria-label={tl("Sign out {label}", { label })}
											className="absolute flex size-5 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-[opacity,scale,color,background-color] duration-150 hover:bg-accent hover:text-status-destructive focus-visible:scale-100 focus-visible:opacity-100 group-hover/item:scale-100 group-hover/item:opacity-100"
											onClick={(event) => handleSignOutAccount(event, account)}
											type="button"
										>
											<HugeiconsIcon className="size-3.5" icon={Logout01Icon} />
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
								<Spinner className="size-4" />
							) : (
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
							)}
							{tl("Add account")}
						</DropdownMenuItem>
					</DropdownMenuGroup>
					{accountItems ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>{accountItems}</DropdownMenuGroup>
						</>
					) : null}
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={onSignOutAll} variant="destructive">
						<HugeiconsIcon className="size-4" icon={Logout01Icon} />
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
						<div className="flex items-center gap-3 py-1">
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
							{tl("Log out")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
