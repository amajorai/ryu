// `ryu connect <agent>`, `ryu disconnect <agent>`, and `ryu doctor agents`: wire
// Ryu's MCP tools into an external coding agent (Claude Code, Codex, Cursor,
// opencode, Gemini CLI). The config formats and the merge/removal rules live in
// agentConnect.ts; this file is the command layer around them: resolving the Core
// URL and node token, the ownership guard, --dry-run/--print, and the doctor probe.

export { connectCommand } from "./agentCommands-connect.ts";
export { disconnectCommand } from "./agentCommands-disconnect.ts";
export {
	type AgentReport,
	type AgentStatus,
	type AgentsDoctorReport,
	buildAgentsDoctorReport,
	type ProbeResult,
	type ProbeStatus,
	probeMcpEndpoint,
	renderAgentsDoctorReport,
	runAgentsDoctor,
} from "./agentCommands-doctor.ts";
