// apps/desktop/src/lib/api/agent-ui-state.ts
//
// Typed client for Core's saved generative-UI widget state (`ui.render`): the
// checklist ticks, form values and calculator inputs a user left in a widget.
// One bulk read per conversation (fetched alongside the transcript, like
// reactions) and one PUT per widget, keyed by the widget's tool call id.

import type { AgentUiSavedState } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

const savedStateSchema = z.object({
	state: z.record(z.string(), z.unknown()),
	submitted: z.boolean().optional().catch(undefined),
	title: z.string().optional().catch(undefined),
});

const listResponseSchema = z.object({
	states: z.record(z.string(), z.unknown()).catch({}),
});

function conversationPath(conversationId: string): string {
	return `/api/conversations/${encodeURIComponent(conversationId)}/ui-state`;
}

/**
 * Every saved widget state in a conversation
 * (`GET /api/conversations/:id/ui-state`). Entries that don't match the saved
 * shape are dropped, so a widget falls back to its spec rather than failing.
 */
export async function listAgentUiStates(
	target: ApiTarget,
	conversationId: string
): Promise<Map<string, AgentUiSavedState>> {
	const body = await request(
		target,
		conversationPath(conversationId),
		undefined,
		listResponseSchema
	);
	const states = new Map<string, AgentUiSavedState>();
	for (const [toolCallId, value] of Object.entries(body.states)) {
		const saved = savedStateSchema.safeParse(value);
		if (saved.success) {
			states.set(toolCallId, saved.data);
		}
	}
	return states;
}

/** Save one widget's state (`PUT /api/conversations/:id/ui-state/:toolCallId`).
 *  Core stores the `state` field opaquely, so the whole saved record goes in it. */
export async function saveAgentUiState(
	target: ApiTarget,
	conversationId: string,
	toolCallId: string,
	saved: AgentUiSavedState
): Promise<void> {
	await request(
		target,
		`${conversationPath(conversationId)}/${encodeURIComponent(toolCallId)}`,
		{ method: "PUT", body: { state: saved } },
		gatewayJsonValueSchema.transform(() => undefined)
	);
}
