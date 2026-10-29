// Typed client for canonical Ryu Action calls.
//
// An Action is still executed by Core as a governed tool. This module only
// provides the action-shaped HTTP projection; it must not become a second
// execution path or accept the internal budget bypass fields used by the
// Gateway's own tool loop.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";

/** The result envelope returned by Core for a successful or denied Action call. */
export interface ActionCallResult {
	error?: string;
	ok: boolean;
	output?: unknown;
}

/** Input accepted by the action HTTP projection. */
export interface ActionCallInput {
	/** Explicit registered Core agent whose allowlist and approval policy apply. */
	agentId: string;
	/** JSON arguments validated by the Action's input schema at dispatch. */
	arguments: unknown;
	/** Optional Composio entity/audit selector; never an authorization principal. */
	userId?: string;
}

interface ActionWriteBody {
	agent_id: ActionCallInput["agentId"];
	arguments: ActionCallInput["arguments"];
	user_id?: ActionCallInput["userId"];
}

function actionWriteBody(input: ActionCallInput): ActionWriteBody {
	const body: ActionWriteBody = {
		agent_id: input.agentId,
		arguments: input.arguments,
	};
	if (input.userId !== undefined) {
		body.user_id = input.userId;
	}
	return body;
}

// Core's action/tool dispatcher publishes success/output or denial/error;
// authorization refusals may omit ok and inherit the HTTP response status.
const actionResponseSchema = z.object({
	ok: z.boolean().nullish(),
	output: appResponseValueSchema.optional(),
	error: z.string().optional(),
});

/** Build the action endpoint path without allowing an id to escape its segment. */
export function actionPath(actionId: string): string {
	const id = actionId.trim();
	if (!id) {
		throw new Error("actionId must not be empty");
	}
	return `/api/actions/${encodeURIComponent(id)}`;
}

/**
 * Call one known Action through Core's protected, approval-aware HTTP surface.
 * Non-2xx responses remain result envelopes so callers can render an approval
 * or policy denial without losing Core's useful error text.
 */
export async function callAction(
	target: ApiTarget,
	actionId: string,
	input: ActionCallInput
): Promise<ActionCallResult> {
	const response = await fetchForTarget(target)(
		apiUrl(target, actionPath(actionId)),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify(actionWriteBody(input)),
		}
	);
	const text = await response.text();
	if (!text) {
		return { ok: response.ok };
	}
	try {
		const decoded = JSON.parse(text);
		if (decoded === null) {
			throw new Error("Core returned a null action result");
		}
		const parsed = actionResponseSchema.parse({ ...decoded });
		return {
			ok: parsed.ok ?? response.ok,
			output: parsed.output,
			error: parsed.error,
		};
	} catch {
		return {
			ok: false,
			error: `Core returned invalid JSON (${response.status})`,
		};
	}
}
