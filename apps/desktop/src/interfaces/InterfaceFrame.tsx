// The host-owned frame every interface is drawn in: the top bar (the Ryu
// lockup, the labelled switcher with Back to chat, Marketplace and Settings)
// and, below it, the renderer's box. The bar is rendered here, never by a
// renderer, for every descriptor and every state (loading, pending, failed).
//
// The box is its own stacking context (`isolate`), a paint containment root
// (`contain: paint`, so even `position: fixed` descendants are clipped to it)
// with its overflow clipped, and renderer overlays (the @ryu/ui dialogs,
// sheets, menus, popovers and tooltips) portal into it. Nothing a renderer
// draws can cover or intercept the bar.

import { Settings02Icon, Store01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { PortalContainerProvider } from "@ryu/ui/components/portal-container.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useState } from "react";
import { SidebarBrandBadge } from "@/src/components/layout/SidebarBrandBadge.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { topBarInsets } from "@/src/lib/window-chrome-layout.ts";

export interface InterfaceFrameProps {
	canSwitchToConsole: boolean;
	/** The renderer (and its boundary), drawn inside the contained box. */
	children: ReactNode;
	/** One line beside the switcher (the interface's description). */
	description?: string | null;
	/** The interface id, for `data-interface`. */
	interfaceId: string;
	/** The interface's name, for the page heading. */
	label: string;
	/** A host notice after the description (e.g. threads left out of the view). */
	notice?: ReactNode;
	/** Open a host page (Marketplace, Settings) over the interface. */
	onOpenPage: (path: string, title: string) => void;
	/** Host-owned content over the renderer inside the box (a page). */
	overlay?: ReactNode;
}

export function InterfaceFrame({
	canSwitchToConsole,
	children,
	description,
	interfaceId,
	label,
	notice,
	onOpenPage,
	overlay,
}: InterfaceFrameProps) {
	// The top bar replaces the titlebar, so it clears the native window
	// controls itself (traffic lights left, caption buttons right).
	const { nativeWindowChrome } = useAppSurface();
	const barInsets = topBarInsets({
		isMac: navigator.userAgent.includes("Mac"),
		nativeWindowChrome,
	});
	// Where the renderer's overlays portal to: inside its own box.
	const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);

	return (
		<div
			className="relative flex size-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
			data-interface={interfaceId}
			data-testid="ryu-interface-surface"
		>
			<header
				// `aria-live` (off: no announcements) is what modal dialogs leave
				// outside their aria-hidden sweep, so a renderer's modal never
				// hides the bar from assistive tech either.
				aria-live="off"
				// Above the box, whose contents are clipped to it.
				className={cn(
					"relative z-30 flex h-12 shrink-0 items-center gap-3 border-border border-b bg-background px-3 sm:px-5",
					barInsets
				)}
				data-tauri-drag-region
				data-testid="ryu-interface-topbar"
			>
				<div className="min-w-0 shrink" data-tauri-drag-region={false}>
					<SidebarBrandBadge
						canSwitchToConsole={canSwitchToConsole}
						canSwitchToOs
						className="px-0 py-0"
						compact
						labelledTrigger
					/>
				</div>
				<h1 className="sr-only" data-ryu-bot-terminology="ignore">
					{label}
				</h1>
				<p
					className="hidden min-w-0 truncate text-muted-foreground text-xs sm:block"
					data-tauri-drag-region
				>
					{description}
				</p>
				{notice}
				<nav
					aria-label="Workspace"
					className="ml-auto flex shrink-0 items-center gap-1"
					data-tauri-drag-region={false}
				>
					<Button
						onClick={() => onOpenPage("/marketplace", "Marketplace")}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							data-icon="inline-start"
							icon={Store01Icon}
						/>
						<span className="hidden sm:inline">Marketplace</span>
						<span className="sr-only sm:hidden">Marketplace</span>
					</Button>
					<Button
						onClick={() => onOpenPage("/settings", "Settings")}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							data-icon="inline-start"
							icon={Settings02Icon}
						/>
						<span className="hidden sm:inline">Settings</span>
						<span className="sr-only sm:hidden">Settings</span>
					</Button>
				</nav>
			</header>
			<div
				className="relative isolate min-h-0 flex-1 overflow-clip"
				data-testid="ryu-interface-box"
				style={{ contain: "paint" }}
			>
				<PortalContainerProvider container={portalHost}>
					{children}
				</PortalContainerProvider>
				<div data-interface-portal-host="" ref={setPortalHost} />
				{overlay}
			</div>
		</div>
	);
}
