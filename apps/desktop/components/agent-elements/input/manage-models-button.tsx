"use client";

import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useAgentAutoDialog } from "@/src/store/useAgentAutoDialog.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

/**
 * The agent picker's single footer row: "Settings" opens a submenu with model
 * management and the Auto routing rules, so the picker ends in one quiet row
 * instead of two.
 */
export function PickerSettingsMenu({ close }: { close: () => void }) {
	const openGateway = useGatewayDialog((state) => state.openGateway);
	const openAgentAutoConfig = useAgentAutoDialog(
		(state) => state.openAgentAutoConfig
	);
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={Settings01Icon} />
				<span className="flex-1 truncate">Settings…</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-48">
				<DropdownMenuItem
					onClick={() => {
						close();
						openGateway("providers");
					}}
				>
					Manage models
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						close();
						openAgentAutoConfig();
					}}
				>
					Configure Auto
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
