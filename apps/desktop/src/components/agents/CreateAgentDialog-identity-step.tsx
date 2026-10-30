import { Button } from "@ryu/ui/components/button.tsx";
import {
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { AgentIdentityModePicker } from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { NO_SANDBOX_NOTE } from "@/src/components/agents/AgentLaunchWarning.tsx";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

interface CreateAgentIdentityStepProps {
	identityMode: AgentIdentityMode;
	onContinue: () => void;
	onIdentityModeChange: (next: AgentIdentityMode) => void;
	showNoSandboxNote: boolean;
}

// The first step of `CreateAgentDialog`: how the agent should work.
export function CreateAgentIdentityStep({
	identityMode,
	onContinue,
	onIdentityModeChange,
	showNoSandboxNote,
}: CreateAgentIdentityStepProps) {
	return (
		<>
			<DialogHeader>
				<DialogTitle>How should this agent work?</DialogTitle>
				<DialogDescription>
					You can change this later in the agent's settings.
				</DialogDescription>
			</DialogHeader>
			<AgentIdentityModePicker
				onChange={onIdentityModeChange}
				size="hero"
				value={identityMode}
			/>
			{showNoSandboxNote ? (
				<p className="text-detail text-muted-foreground" role="status">
					{NO_SANDBOX_NOTE}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button
					className="h-10 w-full sm:w-auto sm:min-w-32"
					onClick={onContinue}
					type="button"
					variant="mono"
				>
					Continue
				</Button>
			</div>
		</>
	);
}
