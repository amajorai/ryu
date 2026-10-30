import {
	type AgentIdentityMode,
	agentIdentityMode,
	agentLaunchCheckResponseSchema,
	encodeAgentPathId,
	toAgentLaunchCheck,
	toAgentLaunchCheckBody,
} from "@ryuhq/core-client/agents";
import { ApiError } from "@ryuhq/core-client/client";
import { z } from "zod";
import { RYU_ENGINE_ID } from "../core/agentIdentity.ts";
import { tf } from "../i18n/translate.ts";
import type { CliContext } from "./types.ts";

// ── Core records ─────────────────────────────────────────────────────────────

const agentRecordSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	engine: z.string().nullish(),
	identity_mode: z.string().nullish(),
	account_access: z.array(z.string()).nullable().optional(),
	locked: z.boolean().optional(),
	updated_at: z.string().nullish(),
});
export const agentEnvelopeSchema = z.looseObject({
	agent: agentRecordSchema,
	// `GET /api/agents/:id` only: where an app's agent got its mode.
	app_identity: z
		.looseObject({ pending_mode: z.string().nullish() })
		.nullish()
		.catch(null),
});
export const agentListSchema = z.looseObject({
	agents: z
		.array(
			z.looseObject({
				id: z.string(),
				name: z.string(),
				engine: z.string().nullish(),
				transport: z.string().nullish(),
			})
		)
		.optional(),
});

export interface AgentIdentityView {
	accountAccess: string[] | null;
	engine: string | null;
	id: string;
	identityMode: AgentIdentityMode;
	locked: boolean;
	name: string;
	/** A mode a newer version of the agent's app asked for, left for the user. */
	pendingIdentityMode: AgentIdentityMode | null;
	updatedAt: string | null;
}

export function toView(
	record: z.output<typeof agentRecordSchema>,
	appIdentity?: { pending_mode?: string | null } | null
): AgentIdentityView {
	const pending = appIdentity?.pending_mode;
	return {
		// An unknown requested mode reads as `individual`; it is only a request.
		pendingIdentityMode: pending ? agentIdentityMode(pending) : null,
		id: record.id,
		name: record.name,
		engine: record.engine ?? null,
		// Missing → managed (a record from before identity modes); unknown →
		// individual, the narrowest, so nothing here can widen it.
		identityMode: agentIdentityMode(record.identity_mode),
		accountAccess: record.account_access ?? null,
		locked: record.locked ?? false,
		updatedAt: record.updated_at ?? null,
	};
}

export function viewJson(view: AgentIdentityView) {
	return {
		id: view.id,
		name: view.name,
		engine: view.engine,
		identity_mode: view.identityMode,
		account_access: view.accountAccess,
		...(view.pendingIdentityMode
			? { pending_identity_mode: view.pendingIdentityMode }
			: {}),
	};
}

/** Core's own words for a refused request, instead of "… failed: 409". */
function coreError(error: unknown, agentId: string | null): Error {
	if (!(error instanceof ApiError)) {
		return error instanceof Error ? error : new Error(String(error));
	}
	if (error.status === 409 && error.serverMessage?.includes("revision")) {
		return new Error(
			`Agent '${agentId}' was changed by someone else while this command ran. Nothing was saved; run it again.`
		);
	}
	if (error.status === 404) {
		return new Error(`Agent '${agentId}' was not found.`);
	}
	return new Error(error.serverMessage ?? error.message);
}

export async function coreCall(
	ctx: CliContext,
	path: string,
	options: { body?: unknown; method: string },
	agentId: string | null
) {
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	try {
		return await ctx.api.call(ctx.target, path, {
			method: options.method,
			body: options.body,
		});
	} catch (error) {
		throw coreError(error, agentId);
	}
}

export async function loadAgent(
	ctx: CliContext,
	id: string
): Promise<AgentIdentityView> {
	const json = await coreCall(
		ctx,
		`/api/agents/${encodeAgentPathId(id)}`,
		{ method: "GET" },
		id
	);
	const parsed = agentEnvelopeSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(`Core returned an unreadable record for agent '${id}'.`);
	}
	return toView(parsed.data.agent, parsed.data.app_identity);
}

/**
 * Ask Core whether the engine would start. Returns Core's refusal, or null when
 * it would start or the check could not be made (reported on stderr).
 */
export async function launchRefusal(
	ctx: CliContext,
	input: {
		accountAccess: string[] | null;
		agentId: string | null;
		engine: string | null;
		identityMode: AgentIdentityMode;
	}
): Promise<string | null> {
	if (!input.engine) {
		return null;
	}
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	let json: unknown;
	try {
		// Called directly, not through coreCall: a 404 here means this Core
		// has no launch check, not that the agent is missing.
		json = await ctx.api.call(ctx.target, "/api/agents/launch-check", {
			method: "POST",
			body: toAgentLaunchCheckBody({ ...input, engine: input.engine }),
		});
	} catch (error) {
		const detail =
			error instanceof ApiError && error.status === 404
				? "this Core has no launch check"
				: coreError(error, input.agentId).message;
		ctx.io.err(
			`${tf("Note: could not ask Core whether the engine will start ({detail}). Saving anyway; Core still checks when the agent starts.", { detail })}\n`
		);
		return null;
	}
	const parsed = agentLaunchCheckResponseSchema.safeParse(json);
	if (!parsed.success) {
		ctx.io.err(
			"Note: Core's launch check gave an unreadable answer. Saving anyway; Core still checks when the agent starts.\n"
		);
		return null;
	}
	const check = toAgentLaunchCheck(parsed.data);
	if (check.modelWarning) {
		ctx.io.err(`Warning: ${check.modelWarning}\n`);
	}
	if (check.launchable) {
		return null;
	}
	const reason =
		check.reason ?? "Core says this agent's engine would not start.";
	const hint =
		input.engine === RYU_ENGINE_ID
			? ""
			: ` ${tf("To run it on Ryu instead, add --engine {RYU_ENGINE_ID}.", { RYU_ENGINE_ID })}`;
	return `${reason} Nothing was saved.${hint}`;
}
