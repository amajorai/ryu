import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
} from "@ryu/ui/components/dropdown-menu.tsx";

export function useAgentCapabilities() {
	return { capabilities: null };
}

export function usePiConfig() {
	return { catalog: null };
}

export function useRoutingAdvice() {
	return { advice: null, refresh: () => undefined };
}

export function useInterfaceLevel(): "simple" {
	return "simple";
}

export function useAgentUsage() {
	return null;
}

export function useUniversalPicker({
	agents,
	onSelectAgent,
}: {
	agents: AgentSummary[];
	onSelectAgent: (agentId: string) => void;
}) {
	return {
		renderBody: (close: () => void) => (
			<DropdownMenuGroup>
				<DropdownMenuLabel>Agents</DropdownMenuLabel>
				<DropdownMenuItem
					closeOnClick={false}
					onClick={() => {
						onSelectAgent("auto");
						close();
					}}
				>
					Auto
				</DropdownMenuItem>
				{agents.map((agent) => (
					<DropdownMenuItem
						closeOnClick={false}
						key={agent.id}
						onClick={() => {
							onSelectAgent(agent.id);
							close();
						}}
					>
						{agent.name}
					</DropdownMenuItem>
				))}
			</DropdownMenuGroup>
		),
	};
}
