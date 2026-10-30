import {
	type AgentIdentityMode,
	encodeAgentPathId,
} from "@ryuhq/core-client/agents";
import {
	ACCOUNT_KEY_FORMATS,
	accountKeyUnusedReason,
	parseAccountKeys,
} from "../core/agentIdentity.ts";
import { tf } from "../i18n/translate.ts";
import type { AgentsArgs } from "./agents-args.ts";
import {
	type AgentIdentityView,
	agentEnvelopeSchema,
	coreCall,
	launchRefusal,
	toView,
	viewJson,
} from "./agents-core.ts";
import { describeAgent, output, requireEditable } from "./agents-output.ts";
import { type CliContext, UsageError } from "./types.ts";

interface AgentPatch {
	accountAccess?: string[] | null;
	/** Dismiss the identity mode the agent's app asked for. */
	dismissPendingIdentityMode?: true;
	engine?: string;
	identityMode?: AgentIdentityMode;
}

/** Launch-check, then PUT only the patched fields with the revision guard. */
export async function saveAgentPatch(
	ctx: CliContext,
	view: AgentIdentityView,
	patch: AgentPatch,
	summary: string
): Promise<number> {
	requireEditable(view);
	const identityMode = patch.identityMode ?? view.identityMode;
	const accountAccess =
		patch.accountAccess === undefined
			? view.accountAccess
			: patch.accountAccess;
	const engine = patch.engine ?? view.engine;
	const refusal = await launchRefusal(ctx, {
		accountAccess,
		agentId: view.id,
		engine,
		identityMode,
	});
	if (refusal) {
		throw new Error(refusal);
	}
	const body: Record<string, unknown> = {};
	if (patch.identityMode !== undefined) {
		body.identity_mode = patch.identityMode;
	}
	if (patch.accountAccess !== undefined) {
		// `null` is meaningful: it clears the allowlist to "no limit".
		body.account_access = patch.accountAccess;
	}
	if (patch.engine !== undefined) {
		body.engine = patch.engine;
	}
	if (patch.dismissPendingIdentityMode) {
		body.dismiss_pending_identity_mode = true;
	}
	if (view.updatedAt) {
		body.expected_updated_at = view.updatedAt;
	}
	if (ctx.flags.dryRun) {
		const preview: AgentIdentityView = {
			...view,
			accountAccess,
			engine,
			identityMode,
		};
		output(
			ctx,
			{ dry_run: true, request: body, agent: viewJson(preview) },
			`${summary} Nothing was saved (--dry-run).\n${describeAgent(preview)}`
		);
		return 0;
	}
	const json = await coreCall(
		ctx,
		`/api/agents/${encodeAgentPathId(view.id)}`,
		{ method: "PUT", body },
		view.id
	);
	const parsed = agentEnvelopeSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`Core saved agent '${view.id}' but returned an unreadable record.`
		);
	}
	// The PUT answer carries no app request: saving the requested mode or
	// dismissing settles it, and any other save leaves it as it was.
	const settled =
		patch.dismissPendingIdentityMode === true ||
		(patch.identityMode !== undefined &&
			patch.identityMode === view.pendingIdentityMode);
	const saved = {
		...toView(parsed.data.agent),
		pendingIdentityMode: settled ? null : view.pendingIdentityMode,
	};
	output(ctx, viewJson(saved), `${summary}\n${describeAgent(saved)}`);
	return 0;
}

export function engineFlag(args: AgentsArgs): string | undefined {
	return args.engine ?? undefined;
}

export function requireKeys(raw: string[], usage: string): string[] {
	if (raw.length === 0) {
		throw new UsageError(`Usage: ${usage}`);
	}
	const { keys, invalid } = parseAccountKeys(raw);
	if (invalid.length > 0) {
		throw new UsageError(
			`Not an account key Core accepts: ${invalid.join(", ")}. Nothing was saved.\nKeys look like:\n  ${ACCOUNT_KEY_FORMATS.join("\n  ")}`
		);
	}
	return keys;
}

export function warnUnusedKeys(
	ctx: CliContext,
	keys: readonly string[],
	mode: AgentIdentityMode
): void {
	for (const key of keys) {
		const reason = accountKeyUnusedReason(key, mode);
		if (reason) {
			ctx.io.err(
				`${tf("Note: {key} is saved but {reason}.", { key, reason })}\n`
			);
		}
	}
}
