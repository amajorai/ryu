// `ryu secrets access …`: time-bound, approval-gated access requests on this
// node (roadmap P1-9) over Core's `/api/vault/access-requests` routes.
//
// A member asks for capabilities on a path glob (`prod/payments/**`, the
// environment first) for a duration with a reason; the approvers of each step
// of the matching access policies approve in order, and the last approval
// grants a policy bound to the requester until the duration ends. Requesters
// never approve their own request (Core enforces it).
//
// In an AI agent session `approve` and `deny` refuse unless a person confirms
// `--human`: the agent would decide under the person's node credential.
// Team, organization and project requests live on the control plane and are
// not reachable through these Core routes.

import {
	createVaultAccessRequest,
	decideVaultAccessRequest,
	getVaultAccessRequest,
	listVaultAccessPolicies,
	listVaultAccessRequests,
	type VaultAccessRequest,
	type VaultAccessRequestDecision,
	type VaultCapability,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { arg, flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const CAPABILITY_FLAG = "--capability";

/** Capabilities a request may ask for; never `admin` or `approve`. */
const REQUESTABLE = new Set<VaultCapability>([
	"list",
	"use",
	"read",
	"write",
	"delete",
]);

const USAGE =
	"Usage: ryu-cli secrets access list [--status S] | get ID | policies | request PATH --capability C[,C…] --ttl 1h --reason WHY | approve ID | deny ID [--reason R] | cancel ID | revoke ID";

/** `--capability read,write --capability use` → `["read", "write", "use"]`. */
export function parseCapabilities(raw: string[]): VaultCapability[] {
	const out: VaultCapability[] = [];
	for (const part of raw.flatMap((value) => value.split(","))) {
		const name = part.trim();
		if (name === "") {
			continue;
		}
		if (!REQUESTABLE.has(name as VaultCapability)) {
			throw new UsageError(
				tf(
					"--capability {name} cannot be requested; use list, use, read, write, or delete.",
					{ name }
				)
			);
		}
		if (!out.includes(name as VaultCapability)) {
			out.push(name as VaultCapability);
		}
	}
	return out;
}

function summary(request: VaultAccessRequest): string {
	const step = request.currentStep ? ` (${request.currentStep})` : "";
	return `${request.id}  ${request.status}${step}  ${request.path}  ${request.capabilities.join(",")}  ${String(request.durationSecs)}s  ${request.requester}`;
}

function describe(request: VaultAccessRequest): string {
	const lines = [
		summary(request),
		`${tf("Reason: {reason}", { reason: request.reason })}`,
		`${tf("Policies: {policies}", { policies: request.policies.join(", ") || "-" })}`,
	];
	for (const step of request.steps) {
		const count = new Set(
			request.approvals
				.filter((approval) => approval.factor === step.name)
				.map((approval) => approval.approver)
		).size;
		lines.push(
			`  ${step.name}: ${String(count)}/${String(step.approvals)}  ${step.approvers.join(", ")}`
		);
	}
	if (request.grantExpiresAt !== undefined) {
		lines.push(
			tf("Granted until {at}.", { at: String(request.grantExpiresAt) })
		);
	}
	if (request.decisionReason) {
		lines.push(tf("Decision: {reason}", { reason: request.decisionReason }));
	}
	return lines.join("\n");
}

async function list(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const status = flag(args, "--status");
	const { accessRequests } = await listVaultAccessRequests(ctx.target);
	const shown = status
		? accessRequests.filter((request) => request.status === status)
		: accessRequests;
	if (ctx.flags.json) {
		printJson(ctx, shown);
		return 0;
	}
	if (shown.length === 0) {
		ctx.io.out(`${tr("No access requests.")}\n`);
		return 0;
	}
	for (const request of shown) {
		ctx.io.out(`${summary(request)}\n`);
	}
	return 0;
}

async function create(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const usage = "access request PATH --capability C[,C…] --ttl 1h --reason WHY";
	const path = arg(args, 2, usage);
	const capabilities = parseCapabilities(
		args.values.get(CAPABILITY_FLAG) ?? []
	);
	const ttl = flag(args, "--ttl");
	const reason = flag(args, "--reason")?.trim();
	if (capabilities.length === 0 || ttl === undefined || !reason) {
		throw new UsageError(`Usage: ryu-cli secrets ${usage}`);
	}
	const { accessRequest } = await createVaultAccessRequest(ctx.target, {
		path,
		capabilities,
		durationSecs: parseDuration(ttl),
		reason,
	});
	if (ctx.flags.json) {
		printJson(ctx, accessRequest);
		return 0;
	}
	ctx.io.out(
		`${tf("Access request {id} is {status}; waiting on {step}.", {
			id: accessRequest.id,
			status: accessRequest.status,
			step: accessRequest.currentStep ?? "-",
		})}\n`
	);
	return 0;
}

function decided(
	decision: VaultAccessRequestDecision,
	request: VaultAccessRequest
): string {
	const { id, status } = request;
	switch (decision) {
		case "approve":
			return tf("Approved access request {id}; it is now {status}.", {
				id,
				status,
			});
		case "deny":
			return tf("Denied access request {id}.", { id });
		case "cancel":
			return tf("Cancelled access request {id}.", { id });
		default:
			return tf("Revoked access request {id}.", { id });
	}
}

async function decide(
	ctx: CliContext,
	args: SecretsArgs,
	decision: VaultAccessRequestDecision,
	agentSession: string | null
): Promise<number> {
	const id = arg(args, 2, `access ${decision} ID`);
	if (agentSession && (decision === "approve" || decision === "deny")) {
		ctx.io.err(
			`${tf("Refusing to decide an access request in an AI agent session ({marker} is set): it would act under your credential. A person at a terminal can add --human.", { marker: agentSession })}\n`
		);
		return 1;
	}
	const reason = decision === "deny" ? flag(args, "--reason") : undefined;
	const { accessRequest } = await decideVaultAccessRequest(
		ctx.target,
		id,
		decision,
		reason
	);
	if (ctx.flags.json) {
		printJson(ctx, accessRequest);
		return 0;
	}
	ctx.io.out(`${decided(decision, accessRequest)}\n`);
	return 0;
}

async function policies(ctx: CliContext): Promise<number> {
	const { accessPolicies } = await listVaultAccessPolicies(ctx.target);
	if (ctx.flags.json) {
		printJson(ctx, accessPolicies);
		return 0;
	}
	if (accessPolicies.length === 0) {
		ctx.io.out(`${tr("No access policies.")}\n`);
		return 0;
	}
	for (const policy of accessPolicies) {
		const steps = policy.steps
			.map(
				(step) =>
					`${step.name} ${String(step.approvals)}/${step.approvers.join("|")}`
			)
			.join(" > ");
		const line = tf("{name}  {path}  {capabilities}  max {seconds}s  {steps}", {
			name: policy.name,
			path: policy.path,
			capabilities: policy.capabilities.join(","),
			seconds: String(policy.maxDurationSecs),
			steps,
		});
		ctx.io.out(`${line}\n`);
	}
	return 0;
}

/** `ryu secrets access …`. `agentSession` is the detected agent marker, or
 *  null for a person (or one who confirmed `--human`). */
export async function accessRequests(
	ctx: CliContext,
	args: SecretsArgs,
	agentSession: string | null = null
): Promise<number> {
	const action = args.positional[1];
	switch (action) {
		case undefined:
		case "list":
		case "ls":
			return await list(ctx, args);
		case "get": {
			const { accessRequest } = await getVaultAccessRequest(
				ctx.target,
				arg(args, 2, "access get ID")
			);
			if (ctx.flags.json) {
				printJson(ctx, accessRequest);
			} else {
				ctx.io.out(`${describe(accessRequest)}\n`);
			}
			return 0;
		}
		case "policies":
			return await policies(ctx);
		case "request":
		case "create":
			return await create(ctx, args);
		case "approve":
		case "deny":
		case "cancel":
		case "revoke":
			return await decide(ctx, args, action, agentSession);
		default:
			throw new UsageError(USAGE);
	}
}
