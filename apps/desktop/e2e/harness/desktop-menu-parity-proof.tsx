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
import { ThemeProvider, useTheme } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	AccountList,
	DesktopThemeSubmenu,
	DesktopWebAccountLinks,
} from "../../src/components/layout/NavUser.tsx";
import { GlobalContextMenu } from "../../src/components/shell/GlobalContextMenu.tsx";
import proofStyles from "./desktop-menu-parity-proof.module.css";
import "../../src/index.css";
import { Check, LogOut, Plus } from "lucide-react";

const standardWebDestinations = [
	{ label: "Profile", path: "/u/demo-user" },
	{ label: "Organizations", path: "/organizations" },
	{ label: "Invite a friend", path: "/referrals" },
	{ label: "Join Discord", path: "/discord" },
	{ label: "Account", path: "/settings" },
	{ label: "Personal access tokens", path: "/api-keys" },
] as const;

const botWebDestinations = [
	{ label: "Account", path: "/settings" },
	{ label: "Organizations", path: "/organizations" },
	{ label: "Join Discord", path: "/discord" },
	{ label: "Download Ryu Build", path: "/download" },
] as const;

const demoStoredAccounts = [
	{
		email: "alex@example.com",
		image: null,
		name: "Alex Chen",
		token: "demo-token-alex",
		userId: "demo-alex",
	},
	{
		email: "sam@example.com",
		image: null,
		name: "Sam Rivera",
		token: "demo-token-sam",
		userId: "demo-sam",
	},
] as const;

window.localStorage.setItem("ryu_accounts", JSON.stringify(demoStoredAccounts));
window.localStorage.setItem("ryu_active_user_id", "demo-alex");

function WebsiteAccountSwitcherProof({
	onSignOutAll,
}: {
	onSignOutAll: () => void;
}) {
	const [activeId, setActiveId] = useState("demo-alex");
	const activeAccount = demoStoredAccounts.find(
		(account) => account.userId === activeId
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger variant="glass">
				Website user nav
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-56">
				<DropdownMenuSub>
					<DropdownMenuSubTrigger spacing="comfortable">
						<span
							className={`flex size-6 shrink-0 items-center justify-center rounded-full ${proofStyles.accountSurface} font-semibold ${proofStyles.accountText} text-xs`}
						>
							{activeAccount?.name.slice(0, 1)}
						</span>
						<span className="flex min-w-0 flex-1 flex-col text-left">
							<span className="truncate text-sm">{activeAccount?.name}</span>
							<span className="truncate text-muted-foreground text-xs">
								{activeAccount?.email}
							</span>
						</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="min-w-64">
						<DropdownMenuGroup>
							{demoStoredAccounts.map((account) => (
								<DropdownMenuItem
									closeOnClick={false}
									key={account.userId}
									onClick={() => setActiveId(account.userId)}
								>
									<span
										className={`flex size-6 shrink-0 items-center justify-center rounded-full ${proofStyles.accountSurface} font-semibold ${proofStyles.accountText} text-xs`}
									>
										{account.name.slice(0, 1)}
									</span>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-sm">{account.name}</span>
										<span className="truncate text-muted-foreground text-xs">
											{account.email}
										</span>
									</span>
									{account.userId === activeId ? (
										<Check className="size-4 shrink-0 text-primary" />
									) : null}
								</DropdownMenuItem>
							))}
							<DropdownMenuItem>
								<Plus className="size-4" />
								Add account
							</DropdownMenuItem>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={onSignOutAll} variant="destructive">
							<LogOut className="size-4" />
							Log out of all accounts
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ThemeState() {
	const { resolvedTheme, theme } = useTheme();
	return (
		<output
			className={`block w-fit rounded-lg border ${proofStyles.panelBorder} ${proofStyles.panelSurface} px-3 py-1 font-mono ${proofStyles.themeText} text-xs`}
			data-resolved-theme={resolvedTheme ?? "unset"}
			data-testid="theme-mode"
			data-theme={theme ?? "unset"}
		>
			{theme ?? "unset"} · {resolvedTheme ?? "unset"}
		</output>
	);
}

function DesktopMenuParityProof() {
	const [standardOpenedPaths, setStandardOpenedPaths] = useState<string[]>([]);
	const [botOpenedPaths, setBotOpenedPaths] = useState<string[]>([]);
	const [accountAction, setAccountAction] = useState("None yet");

	const handleStandardOpenWeb = (path: string) =>
		setStandardOpenedPaths((current) => [...current, path]);
	const handleBotOpenWeb = (path: string) =>
		setBotOpenedPaths((current) => [...current, path]);

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="light"
			enableSystem
			storageKey="ryu-desktop-menu-parity-proof-theme"
		>
			<GlobalContextMenu>
				<main
					className={`min-h-screen ${proofStyles.canvas} p-6 ${proofStyles.primaryText} sm:p-10`}
				>
					<div className="mx-auto flex max-w-5xl flex-col gap-6">
						<ThemeState />
						<header
							className={`flex flex-col gap-4 ${proofStyles.panelBorder} border-b pb-6 sm:flex-row sm:items-start sm:justify-between`}
						>
							<div>
								<p
									className={`font-medium ${proofStyles.mutedText} text-xs uppercase ${proofStyles.labelTracking}`}
								>
									React verification artifact
								</p>
								<h1 className="mt-2 font-semibold text-3xl tracking-tight">
									Desktop menu parity
								</h1>
								<p
									className={`mt-2 max-w-2xl ${proofStyles.mutedText} text-sm leading-6`}
								>
									This proof mounts the production desktop user-nav links, theme
									submenu, and global right-click menu. Use the controls below
									to verify the web destinations and the shared Sun / Moon /
									Laptop icon treatment.
								</p>
							</div>
							<div
								className={`inline-flex w-fit items-center rounded-full border ${proofStyles.statusBorder} ${proofStyles.statusSurface} px-3 py-1.5 font-semibold ${proofStyles.statusText} text-xs`}
								data-testid="proof-status"
							>
								Production components mounted
							</div>
						</header>

						<section
							aria-label="Desktop user navigation proof"
							className={`rounded-2xl border ${proofStyles.panelBorder} ${proofStyles.panelSurface} p-5`}
						>
							<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
								<div>
									<h2 className="font-semibold text-lg">
										Desktop account links
									</h2>
									<p className={`mt-1 ${proofStyles.mutedText} text-sm`}>
										Standard and bot-product menus route to separate web account
										destinations. The standard menu also contains the real theme
										submenu.
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									<DropdownMenu>
										<DropdownMenuTrigger variant="glass">
											Desktop user nav
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="min-w-56">
											<DropdownMenuGroup>
												<DesktopWebAccountLinks
													onOpenWeb={handleStandardOpenWeb}
													profilePath="/u/demo-user"
												/>
											</DropdownMenuGroup>
											<DropdownMenuSeparator />
											<DesktopThemeSubmenu />
										</DropdownMenuContent>
									</DropdownMenu>
									<DropdownMenu>
										<DropdownMenuTrigger variant="glass">
											Bot product user nav
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="min-w-56">
											<DesktopWebAccountLinks
												botProduct
												onOpenWeb={handleBotOpenWeb}
												profilePath="/bot-profile-disabled"
											/>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>
							<div className="mt-5 grid gap-6 lg:grid-cols-2">
								<div>
									<h3 className="mb-2 font-medium text-sm">Standard</h3>
									<div className="grid gap-3 sm:grid-cols-2">
										{standardWebDestinations.map((destination) => (
											<div
												className={`rounded-xl border ${proofStyles.panelBorder} ${proofStyles.resultSurface} p-3`}
												key={destination.label}
											>
												<div className="font-medium text-sm">
													{destination.label}
												</div>
												<code
													className={`mt-1 block ${proofStyles.mutedText} text-xs`}
												>
													{destination.path}
												</code>
											</div>
										))}
									</div>
								</div>
								<div>
									<h3 className="mb-2 font-medium text-sm">Bot product</h3>
									<div className="grid gap-3 sm:grid-cols-2">
										{botWebDestinations.map((destination) => (
											<div
												className={`rounded-xl border ${proofStyles.panelBorder} ${proofStyles.resultSurface} p-3`}
												key={destination.label}
											>
												<div className="font-medium text-sm">
													{destination.label}
												</div>
												<code
													className={`mt-1 block ${proofStyles.mutedText} text-xs`}
												>
													{destination.path}
												</code>
											</div>
										))}
									</div>
								</div>
							</div>
						</section>

						<section
							aria-label="Account switcher submenu proof"
							className={`rounded-2xl border ${proofStyles.panelBorder} ${proofStyles.panelSurface} p-5`}
						>
							<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
								<div>
									<h2 className="font-semibold text-lg">
										Account switcher submenu
									</h2>
									<p
										className={`mt-1 max-w-2xl ${proofStyles.mutedText} text-sm leading-6`}
									>
										Both user-nav triggers keep the active account as the
										submenu trigger. The submenu contains account switching, Add
										account, a separator, and Log out of all accounts.
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									<DropdownMenu>
										<DropdownMenuTrigger variant="glass">
											Desktop active user
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="min-w-56">
											<AccountList
												activeUser={{
													id: "demo-alex",
													name: "Alex Chen",
													email: "alex@example.com",
													image: null,
												}}
												onSignOutAll={() =>
													setAccountAction("Desktop: Log out of all accounts")
												}
											/>
										</DropdownMenuContent>
									</DropdownMenu>
									<WebsiteAccountSwitcherProof
										onSignOutAll={() =>
											setAccountAction("Website: Log out of all accounts")
										}
									/>
								</div>
							</div>
							<div
								className={`mt-5 rounded-xl border ${proofStyles.panelBorder} ${proofStyles.resultSurface} p-3`}
							>
								<div
									className={`${proofStyles.mutedText} text-xs uppercase tracking-wide`}
								>
									Last account action
								</div>
								<div
									className="mt-1 font-mono text-sm"
									data-testid="account-action"
								>
									{accountAction}
								</div>
							</div>
						</section>

						<section
							aria-label="Global context menu proof"
							className={`rounded-2xl border ${proofStyles.panelBorder} ${proofStyles.panelSurface} p-5`}
						>
							<h2 className="font-semibold text-lg">Global right-click menu</h2>
							<p className={`mt-1 ${proofStyles.mutedText} text-sm`}>
								Right-click the panel to open the production menu, then open
								Appearance.
							</p>
							<div
								className={`mt-4 rounded-xl border ${proofStyles.contextBorder} border-dashed ${proofStyles.contextSurface} p-6 text-center ${proofStyles.contextText} text-sm`}
								data-testid="context-target"
							>
								Right-click this panel to inspect Appearance and its Light,
								Dark, and System choices.
							</div>
						</section>

						<section
							aria-label="Interaction results"
							className={`rounded-2xl border ${proofStyles.panelBorder} ${proofStyles.panelSurface} p-5`}
						>
							<h2 className="font-semibold text-lg">Interaction results</h2>
							<dl className="mt-4 grid gap-4 sm:grid-cols-2">
								<div>
									<dt
										className={`${proofStyles.mutedText} text-xs uppercase tracking-wide`}
									>
										Standard destinations selected
									</dt>
									<dd
										className="mt-1 font-mono text-sm"
										data-testid="standard-opened-paths"
									>
										{JSON.stringify(standardOpenedPaths)}
									</dd>
								</div>
								<div>
									<dt
										className={`${proofStyles.mutedText} text-xs uppercase tracking-wide`}
									>
										Bot-product destinations selected
									</dt>
									<dd
										className="mt-1 font-mono text-sm"
										data-testid="bot-opened-paths"
									>
										{JSON.stringify(botOpenedPaths)}
									</dd>
								</div>
							</dl>
						</section>
					</div>
				</main>
			</GlobalContextMenu>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<DesktopMenuParityProof />);
}
