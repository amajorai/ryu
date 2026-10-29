// Standalone browser story for the beui agent surfaces now wired into chat:
// the REAL `PermissionPrompt` (a full `ToolApproval` card), the REAL
// `BashToolTerminalCard` with an approval strip, and the REAL `McpTool` row
// rendering a long JSON payload.
//
// This exists because three of the claims made about these components are only
// answerable by a browser:
//
//   1. `AgentCode` highlights through shiki, whose grammars are async chunks.
//      Whether a command is highlighted at all — and how long it stays plain —
//      is a network-and-microtask property, invisible to tsc and to the
//      bundler. The spec waits for a token span to prove the pipeline lands.
//   2. The approval strip must render one button per ACP option. The old bug
//      was a FIXED pair, so option count is the assertion that would have
//      caught it.
//   3. `McpTool` used to route its output through the markdown renderer, which
//      brought its own scroll container. `ToolResultOutput` has no height cap,
//      so a 3000-character payload could stretch the row instead of scrolling
//      inside it. Only a real layout answers that.
//
// HARNESS LIMIT: motion/react transitions are asserted as end state, not as
// intermediate frames.

import { BashToolTerminalCard } from "@ryu/blocks/desktop/agent-elements/tools/bash-tool.tsx";
import { McpTool } from "@ryu/blocks/desktop/agent-elements/tools/mcp-tool.tsx";
import { createRoot } from "react-dom/client";
import { PermissionPrompt } from "../../src/components/chat/PermissionPrompt.tsx";
import "../../src/index.css";

/** The four options an ACP agent in a gating mode actually offers. */
const OPTIONS = [
	{ optionId: "allow", name: "Allow once", kind: "allow_once" },
	{ optionId: "always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject", name: "Reject", kind: "reject_once" },
	{ optionId: "never", name: "Never allow", kind: "reject_always" },
];

const COMMAND =
	'rg --json "toolCallId" apps/core/src | jq -r ".data.path.text" | sort -u';

const LONG_JSON = JSON.stringify(
	{
		items: Array.from({ length: 120 }, (_, i) => ({
			id: `item-${i}`,
			label: `Result row ${i}`,
			score: i / 120,
		})),
	},
	null,
	2
);

function App() {
	return (
		<div className="flex flex-col gap-6 bg-background p-6 text-foreground">
			<section data-testid="permission-prompt">
				<PermissionPrompt
					onRespond={() => {
						// Story only — the real handler POSTs to /api/chat/permission.
					}}
					permission={{
						requestId: "req-1",
						options: OPTIONS,
						toolCall: {
							toolCallId: "call-1",
							kind: "execute",
							title: "run a shell command",
							rawInput: { command: COMMAND, cwd: "/Users/dev/ryu" },
						},
					}}
				/>
			</section>

			<section data-testid="simple-permission-prompt">
				<PermissionPrompt
					onRespond={() => {
						// Story only — the real handler POSTs to /api/chat/permission.
					}}
					permission={{
						requestId: "req-simple",
						options: OPTIONS,
						toolCall: {
							kind: "execute",
							title: "run a shell command",
							rawInput: { command: COMMAND, cwd: "/Users/dev/ryu" },
						},
					}}
					showTechnicalDetails={false}
				/>
			</section>

			<section data-testid="bash-card">
				<BashToolTerminalCard
					approval={{
						options: OPTIONS,
						onSelect: () => {
							// Story only.
						},
					}}
					onComplete={() => {
						// Story only.
					}}
					state="complete"
					step={{
						type: "tool-call",
						id: "call-1",
						toolName: "Bash",
						toolDetail: COMMAND,
						bashCommand: COMMAND,
						bashOutput: "apps/core/src/sidecar/adapters/acp.rs",
						duration: 0,
					}}
				/>
			</section>

			<section data-testid="mcp-row">
				<McpTool
					defaultOpen
					mcpInfo={{
						category: "search",
						displayName: "Search issues",
						serverName: "linear",
						toolName: "search_issues",
					}}
					part={{
						type: "tool-linear_search_issues",
						toolCallId: "call-2",
						state: "output-available",
						input: { query: "approval" },
						output: LONG_JSON,
					}}
				/>
			</section>
		</div>
	);
}

const container = document.getElementById("root");
if (container) {
	createRoot(container).render(<App />);
}
