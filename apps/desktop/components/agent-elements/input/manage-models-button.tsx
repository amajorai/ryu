"use client";

import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { IconGitBranch } from "@tabler/icons-react";
import { useAgentAutoDialog } from "@/src/store/useAgentAutoDialog.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

/** The picker footer action for model visibility and provider discovery settings. */
export function ManageModelsButton({ close }: { close: () => void }) {
	const openGateway = useGatewayDialog((state) => state.openGateway);

	return (
		<DropdownMenuItem
			onClick={() => {
				close();
				openGateway("providers");
			}}
			spacing="comfortable"
		>
			<HugeiconsIcon icon={Settings01Icon} size={16} strokeWidth={2} />
			<span className="flex-1 truncate">Manage models</span>
		</DropdownMenuItem>
	);
}

/** The picker footer action for the per-turn Auto agent routing rules. */
export function ConfigureAutoButton({ close }: { close: () => void }) {
	const openAgentAutoConfig = useAgentAutoDialog(
		(state) => state.openAgentAutoConfig
	);

	return (
		<DropdownMenuItem
			onClick={() => {
				close();
				openAgentAutoConfig();
			}}
			spacing="comfortable"
		>
			<IconGitBranch className="size-4" />
			<span className="flex-1 truncate">Configure Auto</span>
		</DropdownMenuItem>
	);
}
