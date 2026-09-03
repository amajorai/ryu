import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { BorderBeam } from "@ryu/ui/components/border-beam.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { useTheme } from "next-themes";
import { useBuildProfile } from "@/src/lib/build-profile.ts";
import { channelLabel } from "@/src/lib/channel-brand.ts";
import { setInterfaceLevel } from "@/src/lib/interface-level.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import {
	setProductMode,
	useProductMode,
	useProductModeStore,
} from "@/src/lib/product-mode.ts";
import { useReleaseChannel } from "@/src/lib/release-channel.ts";

interface SidebarBrandBadgeProps {
	/** Only org owners/admins of a managed node should see the switcher. */
	canSwitchToConsole?: boolean;
	/** OS is a workspace surface, so it does not require org-admin access. */
	canSwitchToOs?: boolean;
	className?: string;
	compact?: boolean;
}

function ProductModeLabel({ mode }: { mode: "bot" | "console" | "os" }) {
	return (
		<>
			<span className="font-medium text-foreground text-lg leading-none">
				Ryu
			</span>
			<span className="font-medium text-lg text-muted-foreground leading-none">
				{mode === "bot" ? "Bot" : mode === "os" ? "OS" : "Console"}
			</span>
		</>
	);
}

function setModeAndInterface(mode: "bot" | "console" | "os") {
	if (mode === "console") {
		useProductModeStore.getState().setConsoleAccess(true);
	}
	setProductMode(mode);
	setInterfaceLevel(mode === "bot" ? "simple" : "expert");
}

function releaseBadgeLabel(dev: boolean, channel: string): string {
	const base = channelLabel("stable");
	if (dev) {
		return `${base} (${channelLabel("dev")})`;
	}
	if (channel === "stable") {
		return base;
	}
	return `${base} (${channelLabel(channel)})`;
}

function ReleaseChannelBadge() {
	const { resolvedTheme } = useTheme();
	const { dev } = useBuildProfile();
	const [channel] = useReleaseChannel();
	const beamTheme = resolvedTheme === "light" ? "light" : "dark";

	return (
		<BorderBeam
			borderRadius={999}
			className="beam-notch-bl inline-flex shrink-0"
			colorVariant="colorful"
			size="sm"
			strength={0.85}
			theme={beamTheme}
		>
			<div
				aria-label={`Release: ${releaseBadgeLabel(dev, channel)}`}
				className="beam-notch-bl inline-flex h-5 items-center bg-muted px-2 font-medium text-xs leading-none"
				data-testid="release-channel-badge"
			>
				{releaseBadgeLabel(dev, channel)}
			</div>
		</BorderBeam>
	);
}

function ReleaseChannelFooter() {
	return (
		<div className="flex items-center justify-between gap-3 border-border/60 border-t px-3 py-2">
			<span className="text-muted-foreground text-xs">Release</span>
			<ReleaseChannelBadge />
		</div>
	);
}

/** The shared sidebar product lockup and the gated Bot/Console switcher. */
export function SidebarBrandBadge({
	canSwitchToConsole = false,
	canSwitchToOs = false,
	className,
	compact = false,
}: SidebarBrandBadgeProps = {}) {
	const mode = useProductMode();
	const showSwitcher = !isRyuBot() && (canSwitchToConsole || canSwitchToOs);
	const lockup = (
		<div
			aria-label={`Ryu ${mode}`}
			className="flex min-w-0 items-center gap-2"
			data-testid="product-mode-lockup"
		>
			<Logo
				className="shrink-0 text-foreground"
				size="20px"
				variant="outline"
			/>
			<ProductModeLabel mode={mode} />
		</div>
	);

	if (!showSwitcher) {
		return (
			<div
				className={`${compact ? "w-auto px-0 py-0" : "w-full px-3 py-2"} ${className ?? ""}`}
			>
				{compact ? null : (
					<div className="mt-1.5 flex items-center px-1.5">
						<ReleaseChannelBadge />
					</div>
				)}
				{lockup}
			</div>
		);
	}

	return (
		<div
			className={`${compact ? "w-auto px-0 py-0" : "w-full px-2 py-1.5"} ${className ?? ""}`}
		>
			{compact ? null : (
				<div className="mb-1 flex items-center px-1.5">
					<ReleaseChannelBadge />
				</div>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`Change Ryu product mode, currently ${mode}`}
					render={
						<button
							className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-muted/70"
							data-testid="product-mode-trigger"
							type="button"
						/>
					}
				>
					{lockup}
					<HugeiconsIcon
						className="ml-auto shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
						size={16}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-64" sideOffset={6}>
					<DropdownMenuRadioGroup
						onValueChange={(value) => {
							if (value === "bot" || value === "console" || value === "os") {
								setModeAndInterface(value);
							}
						}}
						value={mode}
					>
						<DropdownMenuRadioItem className="items-start py-2.5" value="bot">
							<span>
								<span className="block font-medium">Bot</span>
								<span className="block text-muted-foreground text-xs">
									Managed chat, ready to use
								</span>
							</span>
						</DropdownMenuRadioItem>
						{canSwitchToOs && (
							<DropdownMenuRadioItem className="items-start py-2.5" value="os">
								<span>
									<span className="block font-medium">OS</span>
									<span className="block text-muted-foreground text-xs">
										Dock, windows, and App Launcher for Ryu Apps
									</span>
								</span>
							</DropdownMenuRadioItem>
						)}
						{canSwitchToConsole && (
							<DropdownMenuRadioItem
								className="items-start py-2.5"
								value="console"
							>
								<span>
									<span className="block font-medium">Console</span>
									<span className="block text-muted-foreground text-xs">
										Configure nodes, models, and organization controls
									</span>
								</span>
							</DropdownMenuRadioItem>
						)}
					</DropdownMenuRadioGroup>
					<ReleaseChannelFooter />
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
