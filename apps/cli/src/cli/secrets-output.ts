import {
	exportVaultSecrets,
	type VaultAgentTarget,
	type VaultChangeRequest,
	type VaultExportFormat,
	type VaultExportInput,
	type VaultExportResult,
	type VaultMachineTarget,
	type VaultSealStatus,
	type VaultWriteResult,
	vaultAgentExport,
} from "@ryuhq/core-client/vault";
import {
	isPlainHttpLoopback,
	requiresCoreIdentity,
	UnverifiableCoreError,
} from "../core/coreIdentity.ts";
import { accessRefusalHint, sharedRefusalCode } from "../core/native-errors.ts";
import { tf } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { type CliContext, UsageError } from "./types.ts";
import { withStepUpHint } from "./vaultStepUp.ts";

// ── Output helpers ───────────────────────────────────────────────────────────

export function printJson(
	ctx: CliContext,
	value: Parameters<typeof JSON.stringify>[0]
): void {
	ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
}

export function policyKey(
	environment: string,
	path: string,
	name: string
): string {
	return path === "/"
		? `${environment}/${name}`
		: `${environment}${path}/${name}`;
}

export function describeChangeRequest(request: VaultChangeRequest): string {
	return tf(
		"Change request {id} created for {key}; it needs {requiredApprovals} approval(s).",
		{
			id: request.id,
			key: policyKey(
				request.coords.environment,
				request.coords.path,
				request.coords.name
			),
			requiredApprovals: String(request.requiredApprovals),
		}
	);
}

export function reportWrite(
	ctx: CliContext,
	result: VaultWriteResult,
	done: (version: number) => string
): number {
	if (ctx.flags.json) {
		printJson(ctx, result);
		return 0;
	}
	if (result.changeRequest) {
		ctx.io.out(`${describeChangeRequest(result.changeRequest)}\n`);
		return 0;
	}
	ctx.io.out(`${done(result.secret?.version ?? 0)}\n`);
	return 0;
}

export function sealLine(seal: VaultSealStatus): string {
	if (!seal.sealed) {
		return `Unsealed (${seal.mode}, data key v${seal.activeKeyVersion}).`;
	}
	return seal.mode === "shamir"
		? `Sealed (shamir): ${seal.progress}/${seal.threshold} key shares submitted.`
		: "Sealed (auto).";
}

// ── Machine-token mode ───────────────────────────────────────────────────────

/**
 * The node as a machine-credential target. A local plain-HTTP address is only
 * trusted once it proves it holds the node token (`coreIdentity.ts`), and the
 * vault token, AppRole secret or wrapping token rides on that verified
 * connection. Without a node token there is nothing to check it with, so the
 * CLI refuses rather than hand a credential to, or take secret values and a
 * broker CA from, whatever holds the port.
 */
export function machineTarget(ctx: CliContext): VaultMachineTarget {
	if (
		isPlainHttpLoopback(ctx.target.url) &&
		!requiresCoreIdentity(ctx.target)
	) {
		throw new UnverifiableCoreError(ctx.target.url);
	}
	// `ctx.target` is built through `withCoreIdentityCheck` (dispatch.ts), so a
	// local target with a node token already verifies before each request.
	const target: VaultMachineTarget = { url: ctx.target.url };
	if (ctx.target.fetch) {
		target.fetch = ctx.target.fetch;
	}
	return target;
}

/** The agent target when `RYU_VAULT_TOKEN` is set, else null (human mode). */
export function agentTarget(ctx: CliContext): VaultAgentTarget | null {
	const token = ctx.env.RYU_VAULT_TOKEN?.trim();
	return token ? { ...machineTarget(ctx), vaultToken: token } : null;
}

const EXPORT_FORMATS = new Map<string, VaultExportFormat>([
	["dotenv", "dotenv"],
	["env", "dotenv"],
	["json", "json"],
	["yaml", "yaml"],
	["shell", "shell"],
	["k8s", "k8s-secret"],
	["k8s-secret", "k8s-secret"],
]);

export function exportFormat(args: SecretsArgs): VaultExportFormat {
	const raw = flag(args, "--format") ?? "dotenv";
	const format = EXPORT_FORMATS.get(raw);
	if (!format) {
		throw new UsageError("--format must be dotenv, json, yaml, shell, or k8s.");
	}
	return format;
}

export async function exportResult(
	ctx: CliContext,
	args: SecretsArgs,
	format: VaultExportFormat
): Promise<VaultExportResult> {
	const location: Pick<VaultExportInput, "environment" | "path"> = {};
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (environment) {
		location.environment = environment;
	}
	if (path) {
		location.path = path;
	}
	const names = args.values.get("--name");
	const agent = agentTarget(ctx);
	if (agent) {
		if (flag(args, "--k8s-name") || flag(args, "--k8s-namespace")) {
			throw new UsageError(
				"--k8s-name/--k8s-namespace are not supported with RYU_VAULT_TOKEN."
			);
		}
		return await vaultAgentExport(agent, { ...location, format, names });
	}
	const result = await withStepUpHint(() =>
		exportVaultSecrets(ctx.target, {
			...location,
			format,
			names,
			k8sName: flag(args, "--k8s-name"),
			k8sNamespace: flag(args, "--k8s-namespace"),
		})
	);
	if (result.sharedError) {
		// An outage or an access refusal leaves the Team and Organization
		// values out; say so on stderr so `export` output and the `run`
		// child's env stay clean.
		ctx.io.err(sharedValuesMissingWarning(result.sharedError));
	}
	return result;
}

/** The stderr warning for an export that left the shared values out. */
function sharedValuesMissingWarning(sharedError: string): string {
	const code = sharedRefusalCode(sharedError);
	if (!code) {
		return `Warning: Team and Organization values are missing because the control plane couldn't be reached (${sharedError}). Only your own and this node's values were used.\n`;
	}
	const hint = accessRefusalHint({ code })?.hint;
	return `Warning: Team and Organization values are missing because the control plane refused this request (${code}).${hint ? ` ${hint}` : ""} Only your own and this node's values were used.\n`;
}
