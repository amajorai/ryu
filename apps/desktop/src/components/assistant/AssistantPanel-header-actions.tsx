import {
	Cancel01Icon,
	Maximize02Icon,
	MessageAdd01Icon,
	MoreHorizontalIcon,
	PanelRightIcon,
	Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { ComposerSettingsMenu } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import type { useComposerSlot } from "./useComposerSlot.tsx";

type AssistantStore = ReturnType<typeof useAssistantStore.getState>;

/** The panel header's action buttons (settings, full screen, dock, options). */
export function AssistantHeaderActions({
	activeComposer,
	bare,
	close,
	handleOpenFullScreen,
	isBuilder,
	isSidebar,
	newConversation,
	setLayout,
}: {
	activeComposer: ReturnType<typeof useComposerSlot>;
	bare: boolean;
	close: AssistantStore["close"];
	handleOpenFullScreen: () => void;
	isBuilder: boolean;
	isSidebar: boolean;
	newConversation: AssistantStore["newConversation"];
	setLayout: AssistantStore["setLayout"];
}) {
	return (
		<>
			{bare && !isBuilder ? (
				<ComposerSettingsMenu
					align="end"
					renderBody={(menuClose) => activeComposer.renderBody(menuClose)}
					sections={activeComposer.triggerSections}
					side="bottom"
					trigger={
						<Button
							aria-label="Assistant settings"
							size="icon-sm"
							title="Assistant settings"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={Settings02Icon} />
						</Button>
					}
				/>
			) : null}
			{/* A surface thread is `persist: false`, so a full-screen hand-off would
			    open an empty conversation; only generic chat offers it. */}
			{bare && isBuilder ? null : bare ? (
				<Button
					aria-label="Open assistant in full screen"
					onClick={handleOpenFullScreen}
					size="icon-sm"
					title="Open in full screen"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={Maximize02Icon} />
				</Button>
			) : (
				<Button
					aria-label={isSidebar ? "Float panel" : "Dock to sidebar"}
					onClick={() => setLayout(isSidebar ? "floating" : "sidebar")}
					size="icon-sm"
					title={isSidebar ? "Float" : "Dock to side"}
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={PanelRightIcon} />
				</Button>
			)}
			{bare || isBuilder ? null : (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label="Assistant options"
								size="icon-sm"
								variant="ghost-muted"
							/>
						}
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-48" sideOffset={4}>
						<DropdownMenuItem onClick={handleOpenFullScreen}>
							<HugeiconsIcon className="size-4" icon={Maximize02Icon} />
							Open in full screen
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => newConversation()}>
							<HugeiconsIcon className="size-4" icon={MessageAdd01Icon} />
							New chat
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => close()}>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							Close
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
}
