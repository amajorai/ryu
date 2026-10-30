import { ArrowDown01Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import {
	type InterfaceDescriptor,
	interfaceTier,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useMemo, useRef, useState } from "react";
import { useResponseModeConfirm } from "@/src/hooks/useResponseModeConfirm.tsx";
import { interfaceIcon } from "@/src/interfaces/interface-icons.ts";
import {
	productModeFor,
	selectInterface,
	useActiveInterfaceFromStore,
	useInterfaceStore,
} from "@/src/interfaces/interface-store.ts";
import {
	backToChat,
	registerInterfaceSwitcher,
} from "@/src/interfaces/interface-switcher.ts";
import { openInterfaceSettings } from "@/src/interfaces/open-interface-settings.ts";
import {
	availableInterfaces,
	interfaceCredit,
} from "@/src/interfaces/registry.ts";
import { useInterfacePrefs } from "@/src/interfaces/use-interface-prefs.ts";
import {
	isFeatureFlagStale,
	refreshFeatureFlags,
} from "@/src/lib/feature-flags.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import { interfaceLevelForProductMode } from "@/src/lib/response-mode-prompt.ts";

interface SidebarBrandBadgeProps {
	/** Only org owners/admins of a managed node should see the switcher. */
	canSwitchToConsole?: boolean;
	/** OS is a workspace surface, so it does not require org-admin access. The
	 *  other workspace interfaces (Channels, Feed, worlds, Marketplace) share it. */
	canSwitchToOs?: boolean;
	className?: string;
	compact?: boolean;
	/**
	 * Keep the lockup as a plain mark and open the menu from a labelled
	 * button beside it (the interface's icon, name and a chevron), for the
	 * full-window interfaces' top bar.
	 */
	labelledTrigger?: boolean;
}

/**
 * The active interface's name beside the Ryu mark ("Agent", "Channels").
 * Interface names are product names, so the bot vocabulary leaves them alone:
 * "Agent" must not read as a second "Bot".
 */
function InterfaceLabel({ label }: { label: string }) {
	return (
		// Marketplace labels may be 64 characters; truncate rather than push the
		// topbar's actions out of a narrow window.
		<span
			className="min-w-0 truncate font-medium text-foreground text-sm"
			data-ryu-bot-terminology="ignore"
			title={label}
		>
			{label}
		</span>
	);
}

function InterfaceRadioItem({
	descriptor,
}: {
	descriptor: InterfaceDescriptor;
}) {
	const credit = interfaceCredit(descriptor);
	return (
		<DropdownMenuRadioItem className="items-start" value={descriptor.id}>
			<span className="min-w-0">
				<span className="block font-medium" data-ryu-bot-terminology="ignore">
					{descriptor.label}
				</span>
				{descriptor.description ? (
					<span className="block text-muted-foreground text-xs">
						{descriptor.description}
					</span>
				) : null}
				{credit ? (
					<span className="block text-muted-foreground text-xs">
						By {credit}
					</span>
				) : null}
			</span>
		</DropdownMenuRadioItem>
	);
}

/** The shared product lockup and the gated interface switcher. */
export function SidebarBrandBadge({
	canSwitchToConsole = false,
	canSwitchToOs: canSwitchToOsProp = false,
	className,
	compact = false,
	labelledTrigger = false,
}: SidebarBrandBadgeProps = {}) {
	const tl = useLiteralMessages();
	const active = useActiveInterfaceFromStore();
	const contributed = useInterfaceStore((state) => state.contributed);
	const workspaceInterfaces = useInterfaceStore(
		(state) => state.workspaceInterfaces
	);
	// OS and the other workspace interfaces are rolled out by flag; the caller's
	// prop says whether this surface may offer the workspace at all.
	const osAccess = useProductModeStore((state) => state.osAccess);
	const canSwitchToOs = canSwitchToOsProp && osAccess;
	const [menuOpen, setMenuOpen] = useState(false);
	const { confirmLevelChange, dialog: responseModeDialog } =
		useResponseModeConfirm();
	const onMenuOpenChange = (open: boolean) => {
		setMenuOpen(open);
		// Opening the switcher is the user action that revalidates the rollout
		// flags behind it, so an interface switched on while Desktop stays open
		// appears without a restart (the refresh is TTL-bounded and shared).
		if (open && isFeatureFlagStale()) {
			refreshFeatureFlags().catch(() => undefined);
		}
	};
	const showSwitcher = !isRyuBot() && (canSwitchToConsole || canSwitchToOs);
	// The Switch Interface hotkey opens whichever switcher is on screen.
	const triggerRef = useRef<HTMLButtonElement>(null);
	const openMenu = useRef(() => onMenuOpenChange(true));
	openMenu.current = () => onMenuOpenChange(true);
	useEffect(() => {
		if (!showSwitcher) {
			return;
		}
		return registerInterfaceSwitcher({
			element: () => triggerRef.current,
			open: () => openMenu.current(),
		});
	}, [showSwitcher]);
	// From a workspace interface (the OS desktop or another layout), the chat
	// is one step back (`backToChat`: Agent where allowed, else Bot).
	const showBackToChat = interfaceTier(active.renderer) === "workspace";
	const options = useMemo(
		() =>
			availableInterfaces({
				canSwitchToConsole,
				canSwitchToOs,
				contributed,
				workspaceInterfaces,
			}),
		[canSwitchToConsole, canSwitchToOs, contributed, workspaceInterfaces]
	);
	const builtins = options.filter((option) => option.origin === "builtin");
	const marketplace = options.filter(
		(option) => option.origin === "marketplace"
	);
	const onValueChange = (value: unknown) => {
		const descriptor = options.find((option) => option.id === value);
		if (descriptor) {
			setMenuOpen(false);
			// Moving between Bot and the Code surfaces changes the response mode
			// in every Ryu assistant thread's system prompt; ask before that.
			confirmLevelChange(
				interfaceLevelForProductMode(productModeFor(descriptor)),
				() => selectInterface(descriptor)
			);
		}
	};
	const lockup = (
		<div
			// As the window title: "Ryu · Agent" never reads as the default agent.
			aria-label={tl("Ryu · {label}", { label: active.label })}
			className="flex min-w-0 items-center gap-2"
			data-ryu-bot-terminology="ignore"
			data-testid="product-mode-lockup"
		>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
				icon={interfaceIcon(active.renderer)}
			/>
			<InterfaceLabel label={active.label} />
		</div>
	);

	if (!showSwitcher) {
		return (
			<div
				className={`${compact ? "w-auto min-w-0 max-w-64 px-0 py-0" : "flex h-9 w-full items-center px-3"} ${className ?? ""}`}
			>
				{lockup}
			</div>
		);
	}

	return (
		<div
			className={`${compact ? "w-auto min-w-0 max-w-64 px-0 py-0" : "w-full px-1"} ${className ?? ""}`}
		>
			<DropdownMenu onOpenChange={onMenuOpenChange} open={menuOpen}>
				{labelledTrigger ? (
					<div className="flex min-w-0 items-center gap-3">
						<div className="flex min-w-0 shrink items-center gap-2">
							<span className="shrink-0 text-foreground">
								<Logo size="20px" variant="outline" />
							</span>
							<span className="font-medium text-foreground text-sm">Ryu</span>
						</div>
						<DropdownMenuTrigger
							aria-label={tl("Switch interface, currently {label}", {
								label: active.label,
							})}
							render={
								<button
									className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 font-medium text-sm transition-colors duration-150 hover:bg-muted hover:duration-0"
									data-ryu-bot-terminology="ignore"
									data-testid="interface-switcher-button"
									ref={triggerRef}
									title="Switch interface"
									type="button"
								/>
							}
						>
							<HugeiconsIcon
								aria-hidden="true"
								className="shrink-0 text-muted-foreground"
								icon={interfaceIcon(active.renderer)}
								size={16}
							/>
							<span className="min-w-0 truncate">{active.label}</span>
							<HugeiconsIcon
								aria-hidden="true"
								className="shrink-0 text-muted-foreground"
								icon={ArrowDown01Icon}
								size={14}
							/>
						</DropdownMenuTrigger>
					</div>
				) : (
					<DropdownMenuTrigger
						aria-label={tl("Change Ryu interface, currently {label}", {
							label: active.label,
						})}
						render={
							<button
								className="group/mode flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0 aria-expanded:bg-sidebar-accent/60"
								data-ryu-bot-terminology="ignore"
								data-testid="product-mode-trigger"
								ref={triggerRef}
								title="Switch interface"
								type="button"
							/>
						}
					>
						{lockup}
						<HugeiconsIcon
							className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/mode:opacity-100 group-hover/mode:duration-0 group-aria-expanded/mode:opacity-100"
							icon={ArrowDown01Icon}
						/>
					</DropdownMenuTrigger>
				)}
				<DropdownMenuContent
					align="start"
					className="min-w-64"
					sideOffset={6}
					withBackdrop={false}
				>
					{showBackToChat ? (
						<>
							<DropdownMenuItem
								data-testid="interface-back-to-chat"
								onClick={() => {
									setMenuOpen(false);
									backToChat(canSwitchToConsole);
								}}
							>
								<HugeiconsIcon
									aria-hidden="true"
									icon={ArrowLeft01Icon}
									size={16}
								/>
								Back to chat
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					) : null}
					<DropdownMenuRadioGroup
						onValueChange={onValueChange}
						value={active.id}
					>
						{builtins.map((descriptor) => (
							<InterfaceRadioItem descriptor={descriptor} key={descriptor.id} />
						))}
					</DropdownMenuRadioGroup>
					{marketplace.length > 0 ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuRadioGroup
								onValueChange={onValueChange}
								value={active.id}
							>
								<DropdownMenuLabel>From the Marketplace</DropdownMenuLabel>
								{marketplace.map((descriptor) => (
									<InterfaceRadioItem
										descriptor={descriptor}
										key={descriptor.id}
									/>
								))}
							</DropdownMenuRadioGroup>
						</>
					) : null}
					{canSwitchToOs ? (
						<>
							<DropdownMenuSeparator />
							<InterfaceSettingsItem
								interfaceId={active.id}
								onOpen={() => setMenuOpen(false)}
							/>
							<HideWorkDetailsItem />
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{responseModeDialog}
		</div>
	);
}

/** Opens Settings → Appearance → Interfaces on the active interface. */
function InterfaceSettingsItem({
	interfaceId,
	onOpen,
}: {
	interfaceId: string;
	onOpen: () => void;
}) {
	return (
		<DropdownMenuItem
			data-testid="interface-settings-open"
			onClick={() => {
				onOpen();
				openInterfaceSettings(interfaceId);
			}}
		>
			Interface settings…
		</DropdownMenuItem>
	);
}

/**
 * Redacts every interface (titles, message text, ask details) for a shared
 * screen, as streaming privacy does. A menu checkbox, so it announces its state.
 */
function HideWorkDetailsItem() {
	const hideWorkDetails = useInterfacePrefs((state) => state.hideWorkDetails);
	const setHideWorkDetails = useInterfacePrefs(
		(state) => state.setHideWorkDetails
	);
	return (
		<DropdownMenuCheckboxItem
			checked={hideWorkDetails}
			data-testid="interface-hide-work-details"
			onCheckedChange={(checked) => setHideWorkDetails(checked === true)}
		>
			Hide work details
		</DropdownMenuCheckboxItem>
	);
}
