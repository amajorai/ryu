import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { createRoot } from "react-dom/client";
import {
	SIDEBAR_TRANSPARENCY_KEY,
	useSidebarTransparency,
	useWindowTransparency,
	WINDOW_TRANSPARENCY_KEY,
} from "../../src/hooks/useWindowTransparency.ts";
import "../../src/index.css";

const PROOF_RESET_KEY = "ryu:appearance-transparency-proof-reset";
if (sessionStorage.getItem(PROOF_RESET_KEY) !== "true") {
	localStorage.removeItem(SIDEBAR_TRANSPARENCY_KEY);
	localStorage.removeItem(WINDOW_TRANSPARENCY_KEY);
	sessionStorage.setItem(PROOF_RESET_KEY, "true");
}
document.documentElement.classList.add("dark");

function SurfaceState({
	sidebarTransparent,
	windowTransparent,
}: {
	sidebarTransparent: boolean;
	windowTransparent: boolean;
}) {
	return (
		<div
			className="flex flex-wrap gap-2 text-muted-foreground text-xs"
			data-testid="surface-state"
		>
			<span className="rounded-full bg-muted/60 px-2.5 py-1">
				Sidebar: {sidebarTransparent ? "glass on" : "opaque"}
			</span>
			<span className="rounded-full bg-muted/60 px-2.5 py-1">
				Window: {windowTransparent ? "glass on" : "opaque"}
			</span>
		</div>
	);
}

function Proof() {
	const [sidebarTransparent, setSidebarTransparent] = useSidebarTransparency();
	const [windowTransparent, setWindowTransparent] = useWindowTransparency();

	return (
		<div className="min-h-dvh bg-os-desktop p-8 text-foreground">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex flex-col gap-2">
					<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
						Appearance
					</p>
					<h1 className="font-heading font-semibold text-3xl tracking-tight">
						Window surfaces
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm leading-6">
						Two independent controls for the sidebar and the full app canvas.
						The system backdrop stays underneath both surfaces.
					</p>
				</header>

				<div
					className="relative flex min-h-[24rem] overflow-hidden rounded-4xl border border-white/20 bg-background shadow-2xl"
					data-ryu-window-root="true"
					data-testid="window-root"
				>
					<aside
						className="relative flex w-56 shrink-0 flex-col gap-4 bg-sidebar p-4 text-sidebar-foreground"
						data-slot="sidebar-inner"
						data-testid="sidebar-surface"
					>
						<div className="flex items-center gap-2">
							<div className="flex size-8 items-center justify-center rounded-xl bg-primary font-semibold text-primary-foreground text-xs">
								R
							</div>
							<div>
								<p className="font-semibold text-sm">Ryu</p>
								<p className="text-sidebar-foreground/60 text-xs">Workspace</p>
							</div>
						</div>
						<div className="space-y-1 text-sm">
							<div className="rounded-xl bg-sidebar-accent px-3 py-2">
								Chats
							</div>
							<div className="rounded-xl px-3 py-2 text-sidebar-foreground/65">
								Agents
							</div>
							<div className="rounded-xl px-3 py-2 text-sidebar-foreground/65">
								Spaces
							</div>
						</div>
					</aside>

					<main
						className="relative flex min-w-0 flex-1 flex-col gap-5 bg-background p-7"
						data-slot="sidebar-inset"
						data-testid="window-surface"
					>
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-muted-foreground text-xs">Today</p>
								<h2 className="mt-1 font-semibold text-xl">
									A calm translucent shell
								</h2>
							</div>
							<SurfaceState
								sidebarTransparent={sidebarTransparent}
								windowTransparent={windowTransparent}
							/>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="rounded-2xl border border-border/60 bg-card/85 p-4">
								<p className="font-medium text-sm">Sidebar glass</p>
								<p className="mt-1 text-muted-foreground text-xs leading-5">
									Reveal only the navigation surface.
								</p>
							</div>
							<div className="rounded-2xl border border-border/60 bg-card/85 p-4">
								<p className="font-medium text-sm">Window glass</p>
								<p className="mt-1 text-muted-foreground text-xs leading-5">
									Reveal the full app canvas independently.
								</p>
							</div>
						</div>
					</main>
				</div>

				<SettingsSection
					caption="These switches are independent and apply immediately."
					title="Transparency"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
									aria-label="Transparent sidebar"
									checked={sidebarTransparent}
									id="transparent-sidebar-toggle"
									onCheckedChange={setSidebarTransparent}
								/>
							}
							description="Reveal the native backdrop through the sidebar only."
							title="Transparent sidebar"
						/>
						<SettingsItem
							actions={
								<Switch
									aria-label="Transparent window"
									checked={windowTransparent}
									id="transparent-window-toggle"
									onCheckedChange={setWindowTransparent}
								/>
							}
							description="Reveal the native backdrop through the full app canvas."
							title="Transparent window"
						/>
					</SettingsGroup>
				</SettingsSection>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Proof root is missing");
}

createRoot(root).render(<Proof />);
