// The interface switcher for when no switcher menu is on screen (a collapsed
// sidebar, a hidden logo): the Switch Interface hotkey opens this dialog
// instead, with the same choices as the Ryu lockup's menu.

import { ArrowLeft01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type InterfaceDescriptor,
	interfaceTier,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { interfaceIcon } from "@/src/interfaces/interface-icons.ts";
import {
	selectInterface,
	useActiveInterfaceFromStore,
	useInterfaceStore,
} from "@/src/interfaces/interface-store.ts";
import {
	backToChat,
	useInterfaceSwitcher,
} from "@/src/interfaces/interface-switcher.ts";
import { openInterfaceSettings } from "@/src/interfaces/open-interface-settings.ts";
import { availableInterfaces } from "@/src/interfaces/registry.ts";
import { useInterfacePrefs } from "@/src/interfaces/use-interface-prefs.ts";
import { useProductModeStore } from "@/src/lib/product-mode.ts";

const ROW =
	"flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";

function Choice({
	active,
	descriptor,
	onPick,
}: {
	active: boolean;
	descriptor: InterfaceDescriptor;
	onPick: (descriptor: InterfaceDescriptor) => void;
}) {
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={ROW}
				onClick={() => onPick(descriptor)}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-muted-foreground"
					icon={interfaceIcon(descriptor.renderer)}
					size={18}
				/>
				<span className="min-w-0 flex-1">
					<span className="block font-medium" data-ryu-bot-terminology="ignore">
						{descriptor.label}
					</span>
					{descriptor.description ? (
						<span className="block truncate text-muted-foreground text-xs">
							{descriptor.description}
						</span>
					) : null}
				</span>
				{active ? (
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0"
						icon={Tick01Icon}
						size={16}
					/>
				) : null}
			</button>
		</li>
	);
}

export function InterfaceSwitcherDialog({
	canSwitchToConsole,
	canSwitchToOs: canSwitchToOsProp,
}: {
	canSwitchToConsole: boolean;
	canSwitchToOs: boolean;
}) {
	const open = useInterfaceSwitcher((state) => state.fallbackOpen);
	const setOpen = useInterfaceSwitcher((state) => state.setFallbackOpen);
	const active = useActiveInterfaceFromStore();
	const contributed = useInterfaceStore((state) => state.contributed);
	const workspaceInterfaces = useInterfaceStore(
		(state) => state.workspaceInterfaces
	);
	const osAccess = useProductModeStore((state) => state.osAccess);
	const canSwitchToOs = canSwitchToOsProp && osAccess;
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
	const pick = (descriptor: InterfaceDescriptor) => {
		setOpen(false);
		selectInterface(descriptor);
	};
	const hideWorkDetails = useInterfacePrefs((state) => state.hideWorkDetails);
	const setHideWorkDetails = useInterfacePrefs(
		(state) => state.setHideWorkDetails
	);
	const showBackToChat = interfaceTier(active.renderer) === "workspace";

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogContent
				className="sm:max-w-md"
				data-testid="interface-switcher-dialog"
			>
				<DialogHeader>
					<DialogTitle>Switch interface</DialogTitle>
					<DialogDescription>
						Choose how Ryu looks. Your conversations stay the same.
					</DialogDescription>
				</DialogHeader>
				{showBackToChat ? (
					<button
						className={ROW}
						data-testid="interface-switcher-back-to-chat"
						onClick={() => {
							setOpen(false);
							backToChat(canSwitchToConsole);
						}}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-muted-foreground"
							icon={ArrowLeft01Icon}
							size={18}
						/>
						<span className="font-medium">Back to chat</span>
					</button>
				) : null}
				<ul
					aria-label="Interfaces"
					className="-mx-1 max-h-[60vh] overflow-y-auto"
				>
					{options.map((descriptor) => (
						<Choice
							active={descriptor.id === active.id}
							descriptor={descriptor}
							key={descriptor.id}
							onPick={pick}
						/>
					))}
				</ul>
				{canSwitchToOs ? (
					<div className="border-t pt-2">
						<button
							className={ROW}
							data-testid="interface-switcher-settings"
							onClick={() => {
								setOpen(false);
								openInterfaceSettings(active.id);
							}}
							type="button"
						>
							<span className="font-medium">Interface settings…</span>
						</button>
						<div className={`${ROW} justify-between`}>
							<span className="font-medium" id="interface-switcher-hide-label">
								Hide work details
							</span>
							<Switch
								aria-labelledby="interface-switcher-hide-label"
								checked={hideWorkDetails}
								data-testid="interface-switcher-hide-work-details"
								onCheckedChange={(checked) => setHideWorkDetails(checked)}
							/>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
