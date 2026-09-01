import { describe, expect, it } from "bun:test";
import {
	passportActionLabel,
	passportRowFromGateway,
	passportRowFromOrganizationControl,
} from "@/src/lib/agent-passport.ts";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import type { OrganizationAuditEntry } from "@/src/lib/api/orgs.ts";

function gatewayEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
	return {
		api_key: "sk-redacted",
		backend: null,
		command: null,
		cost_micro_usd: null,
		duration_ms: null,
		error: null,
		eval_score: null,
		event_type: "model_call",
		feature: "chat",
		id: "row-1",
		input_tokens: 10,
		latency_ms: 42,
		model: "gpt-5",
		output_tokens: 5,
		provider: "openai",
		request_id: "request-1",
		session_id: "session-1",
		source: "byok",
		timestamp: "2026-09-01T10:00:00.000Z",
		user_id: "user-1",
		user_name: "Jia Wei",
		widget_instance_id: null,
		agent_id: "agent-support",
		...overrides,
	};
}

describe("agent passport activity", () => {
	it("turns agent and caller metadata into a traceable model row", () => {
		const row = passportRowFromGateway(gatewayEntry(), "Support agent");

		expect(row.agentAction).toBe(true);
		expect(row.actorLabel).toBe("Support agent");
		expect(row.actorId).toBe("agent-support");
		expect(row.initiatedBy).toBe("Jia Wei");
		expect(row.initiatedById).toBe("user-1");
		expect(row.requestId).toBe("request-1");
		expect(row.sessionId).toBe("session-1");
		expect(row.eventLabel).toBe("Model call");
	});

	it("keeps human control changes separate from agent work", () => {
		const entry: OrganizationAuditEntry = {
			action: "agent.update: successful Core agent-management mutation",
			agentId: "agent-support",
			actor: {
				email: "jia@example.com",
				id: "user-1",
				name: "Jia Wei",
				type: "user",
			},
			details: { status: 200 },
			error: null,
			eventType: "control_change",
			feature: "control",
			id: "control-1",
			requestId: null,
			scope: "gateway",
			sessionId: null,
			target: "agent:agent-support",
			targetId: "agent-support",
			timestamp: "2026-09-01T09:00:00.000Z",
		};

		const row = passportRowFromOrganizationControl(entry);
		expect(row.agentAction).toBe(false);
		expect(row.actorLabel).toBe("Jia Wei");
		expect(row.eventLabel).toBe("Agent configuration changed");
		expect(row.target).toContain("agent-support");
	});

	it("humanizes action codes while preserving the raw action separately", () => {
		expect(
			passportActionLabel("agent.prompt-version.restore: route summary")
		).toBe("Prompt version restored");
		expect(passportActionLabel("custom.event")).toBe("Custom event");
	});
});
