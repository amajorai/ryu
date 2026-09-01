import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AgentPassportPanel } from "../../src/components/agents/AgentPassportPanel.tsx";
import type { Agent } from "../../src/lib/api/agents.ts";
import type { AuditEntry } from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

const NOW = Date.now();
const TARGET_ORIGIN = "http://127.0.0.1:8980";

const agent: Agent = {
	builtIn: false,
	canCreateAgents: false,
	chatModel: { engine: "openai", modelId: "gpt-5" },
	composioActions: ["GMAIL_SEND_EMAIL"],
	createdAt: new Date(NOW - 18 * 24 * 60 * 60 * 1000).toISOString(),
	description: "Turns support requests into reviewed, traceable resolutions.",
	engine: "openai",
	id: "agent-support",
	identityProfileIds: ["support-ops"],
	inference: null,
	lifecycleStatus: "active",
	locked: false,
	memory: {
		read_levels: ["agent", "project"],
		space_ids: ["support-handbook"],
		write_enabled: false,
	},
	model: "gpt-5",
	name: "Support operations",
	orchestrator: false,
	persona: null,
	safetyProfile: "approval_required",
	skills: ["support-triage"],
	systemPrompt: "Classify, draft, and ask for approval before sending.",
	title: "Customer support",
	tools: ["browser.search", "mail.draft", "mail.send"],
	updatedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
	version: "1.4.2",
};

const auditEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
	agent_id: "agent-support",
	api_key: "sk-redacted",
	backend: null,
	command: null,
	cost_micro_usd: 4200,
	duration_ms: null,
	error: null,
	eval_score: 0.94,
	event_type: "model_call",
	feature: "chat",
	id: "audit-model-01",
	input_tokens: 820,
	latency_ms: 1180,
	model: "gpt-5",
	output_tokens: 240,
	provider: "openai",
	request_id: "req-01-support",
	session_id: "support-session-01",
	source: "managed",
	timestamp: new Date(NOW - 12 * 60 * 1000).toISOString(),
	user_id: "user-jiawei",
	user_name: "Jia Wei",
	widget_instance_id: null,
	...overrides,
});

const auditEntries: AuditEntry[] = [
	auditEntry(),
	auditEntry({
		backend: "core-tool",
		command: "mail.draft",
		cost_micro_usd: null,
		duration_ms: 860,
		eval_score: null,
		event_type: "exec_call",
		feature: "agent",
		id: "audit-tool-01",
		input_tokens: 0,
		latency_ms: 860,
		model: "core-tool",
		output_tokens: 0,
		provider: "sandbox",
		request_id: "req-02-support",
		timestamp: new Date(NOW - 9 * 60 * 1000).toISOString(),
	}),
	auditEntry({
		backend: "manual",
		command: "support.example.com",
		cost_micro_usd: null,
		duration_ms: null,
		eval_score: null,
		event_type: "credential_read",
		feature: "agent",
		id: "audit-credential-01",
		latency_ms: 0,
		model: "manual",
		provider: "identity",
		request_id: "req-03-support",
		timestamp: new Date(NOW - 7 * 60 * 1000).toISOString(),
	}),
	auditEntry({
		agent_id: "agent-support",
		backend: "gateway_admin",
		command: "agent.update: successful Core agent-management mutation",
		cost_micro_usd: null,
		eval_score: null,
		event_type: "control_change",
		feature: "control",
		id: "audit-control-01",
		input_tokens: 0,
		latency_ms: 0,
		model: "agent:agent-support",
		output_tokens: 0,
		provider: "gateway_control",
		request_id: "control-01",
		session_id: null,
		timestamp: new Date(NOW - 3 * 60 * 1000).toISOString(),
	}),
];

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof Request
				? input.url
				: input.url;
	if (url.includes("/api/gateway/audit")) {
		return new Response(
			JSON.stringify({
				count: auditEntries.length,
				entries: auditEntries,
				reachable: true,
			}),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}
	return originalFetch(input, init);
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-5xl">
				<div className="mb-6 border-b pb-5">
					<p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.18em]">
						Ryu governance proof · agent level
					</p>
					<h1 className="mt-2 font-semibold text-2xl tracking-tight">
						Agent passport
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
						A real desktop passport projection with representative redacted
						Gateway rows: the agent&apos;s work is separated from the org member
						who changed its controls.
					</p>
				</div>
				<AgentPassportPanel
					agent={agent}
					target={{ token: "proof", url: TARGET_ORIGIN }}
				/>
			</div>
		</main>
	</QueryClientProvider>
);
