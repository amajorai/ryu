import {
	type CreateServerInput,
	type McpServerRow,
	type McpToolRow,
	ToolsView,
} from "@ryu/blocks/desktop/tools";
import { useMcp } from "@/src/hooks/useMcp.ts";

export default function ToolsPage() {
	const {
		servers,
		tools,
		agents,
		agentFilter,
		setAgentFilter,
		loading,
		error,
		callTool,
		createServer,
		reload,
	} = useMcp();

	const serverRows: McpServerRow[] = servers.map((s) => ({
		name: s.name,
		enabled: s.enabled,
		available: s.available ?? undefined,
		description: s.description,
		command: s.command,
		args: s.args,
	}));

	const toolRows: McpToolRow[] = tools.map((t) => ({
		id: t.id,
		name: t.name,
		server: t.server,
		description: t.description,
	}));

	return (
		<ToolsView
			agentFilter={agentFilter}
			agents={agents}
			error={error}
			loading={loading}
			onAgentFilterChange={setAgentFilter}
			onCallTool={callTool}
			onCreateServer={(input: CreateServerInput) => createServer(input)}
			onRetry={() => {
				reload().catch(() => undefined);
			}}
			servers={serverRows}
			tools={toolRows}
		/>
	);
}
