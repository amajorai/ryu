import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	DropDrawer,
	DropDrawerCheckboxItem,
	DropDrawerContent,
	DropDrawerGroup,
	DropDrawerItem,
	DropDrawerLabel,
	DropDrawerRadioGroup,
	DropDrawerRadioItem,
	DropDrawerSeparator,
	DropDrawerSub,
	DropDrawerSubContent,
	DropDrawerSubTrigger,
	DropDrawerTrigger,
} from "@ryu/ui/components/dropdrawer.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

function DropDrawerProof() {
	const [theme, setTheme] = useState("system");
	const [soundsEnabled, setSoundsEnabled] = useState(true);
	const [action, setAction] = useState("No action selected");

	return (
		<main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 bg-background px-6 py-12 text-foreground">
			<header className="grid gap-2">
				<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Ryu responsive menus
				</p>
				<h1 className="font-heading font-semibold text-3xl">DropDrawer</h1>
				<p className="max-w-xl text-muted-foreground text-sm">
					One menu API. A positioned dropdown on wide screens and a bottom
					drawer on mobile.
				</p>
			</header>

			<section className="grid gap-4 rounded-3xl border bg-card p-5">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div className="grid gap-1">
						<h2 className="font-medium text-base">Preferences</h2>
						<p className="text-muted-foreground text-sm">
							Theme: <span data-testid="theme-value">{theme}</span>
							<span className="px-2">·</span>
							Sounds{" "}
							<span data-testid="sound-value">
								{soundsEnabled ? "On" : "Off"}
							</span>
						</p>
					</div>
					<DropDrawer>
						<DropDrawerTrigger variant="dialog-control">
							Open preferences
						</DropDrawerTrigger>
						<DropDrawerContent drawerLabel="Preferences">
							<DropDrawerGroup>
								<DropDrawerLabel>Account</DropDrawerLabel>
								<DropDrawerItem
									data-testid="profile-action"
									onClick={() => setAction("Profile opened")}
								>
									Profile
								</DropDrawerItem>
								<DropDrawerItem
									data-testid="settings-action"
									onClick={() => setAction("Settings opened")}
								>
									Settings
								</DropDrawerItem>
							</DropDrawerGroup>
							<DropDrawerSeparator />
							<DropDrawerSub>
								<DropDrawerSubTrigger>Appearance</DropDrawerSubTrigger>
								<DropDrawerSubContent>
									<DropDrawerSub>
										<DropDrawerSubTrigger>Theme</DropDrawerSubTrigger>
										<DropDrawerSubContent>
											<DropDrawerRadioGroup
												onValueChange={setTheme}
												value={theme}
											>
												<DropDrawerRadioItem value="light">
													Light
												</DropDrawerRadioItem>
												<DropDrawerRadioItem value="dark">
													Dark
												</DropDrawerRadioItem>
												<DropDrawerRadioItem value="system">
													System
												</DropDrawerRadioItem>
											</DropDrawerRadioGroup>
										</DropDrawerSubContent>
									</DropDrawerSub>
									<DropDrawerCheckboxItem
										checked={soundsEnabled}
										onCheckedChange={(checked) =>
											setSoundsEnabled(checked === true)
										}
									>
										Interaction sounds
									</DropDrawerCheckboxItem>
								</DropDrawerSubContent>
							</DropDrawerSub>
						</DropDrawerContent>
					</DropDrawer>
				</div>
				<p
					aria-live="polite"
					className="text-muted-foreground text-sm"
					data-testid="action-result"
				>
					{action}
				</p>
			</section>

			<section className="grid max-w-sm gap-3 rounded-3xl border bg-card p-5">
				<div className="grid gap-1">
					<h2 className="font-medium text-base">Existing menu API</h2>
					<p className="text-muted-foreground text-sm">
						Current DropdownMenu callers receive the same responsive behavior.
					</p>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger variant="dialog-control">
						Open existing menu
					</DropdownMenuTrigger>
					<DropdownMenuContent drawerLabel="Existing menu">
						<DropdownMenuItem
							data-testid="legacy-action"
							onClick={() => setAction("Existing menu action")}
						>
							Legacy action
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</section>
		</main>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("DropDrawer proof root is missing.");
}

createRoot(rootElement).render(<DropDrawerProof />);
