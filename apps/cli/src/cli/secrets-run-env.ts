// The environment `ryu secrets run` (without `--broker`) hands its command:
// the exported values, narrowed by `--tags`, plus one dynamic credential per
// `--lease ROLE[=PREFIX]` whose lease is revoked when the command ends.
//
// Nothing here prints a value. Warnings and errors name variables, roles, and
// lease ids only.

import {
	issueVaultDynamicCredential,
	listVaultSecrets,
	parseVaultJsonExport,
	type VaultDynamicCredential,
	type VaultSecret,
	vaultAgentDynamicIssue,
	vaultAgentLease,
	vaultLease,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
import { childRuntimeEnvironment } from "./secrets-broker.ts";
import { agentTarget, exportResult } from "./secrets-output.ts";
import { tagFilter } from "./secrets-project.ts";
import { type CliContext, UsageError } from "./types.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface LeaseSpec {
	prefix: string;
	role: string;
}

/** One prepared run: the child's environment, the leases it holds, and the
 *  cleanup that revokes them. */
export interface PreparedRun {
	cleanup: () => Promise<void>;
	env: Record<string, string>;
	leaseIds: Set<string>;
}

/** `ROLE` → prefix `ROLE` upper-cased; `ROLE=PREFIX` keeps the given prefix. */
export function parseLeaseSpec(spec: string): LeaseSpec {
	const at = spec.indexOf("=");
	const role = (at === -1 ? spec : spec.slice(0, at)).trim();
	const prefix =
		at === -1
			? role.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
			: spec.slice(at + 1).trim();
	if (!role) {
		throw new UsageError("--lease needs a dynamic role: --lease ROLE[=PREFIX]");
	}
	if (!ENV_NAME.test(prefix)) {
		throw new UsageError(
			tf(
				"--lease {spec}: the prefix '{prefix}' is not a valid variable name.",
				{ spec, prefix }
			)
		);
	}
	return { role, prefix };
}

/** `accessKeyId` → `ACCESS_KEY_ID`, `password` → `PASSWORD`. */
export function fieldVariable(prefix: string, field: string): string {
	const snake = field
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	return snake ? `${prefix}_${snake}` : prefix;
}

/**
 * The names whose every visible row carries one of `tags`. A name with any
 * untagged row is left out, so a filter never injects a value whose
 * effective row lacks the tag.
 */
export function namesWithTags(
	secrets: VaultSecret[],
	tags: string[]
): string[] {
	const wanted = new Set(tags);
	const verdict = new Map<string, boolean>();
	for (const secret of secrets) {
		if (secret.status === "deleted") {
			continue;
		}
		const tagged = secret.metadata.tags.some((tag) => wanted.has(tag));
		verdict.set(secret.name, (verdict.get(secret.name) ?? true) && tagged);
	}
	return [...verdict].filter(([, tagged]) => tagged).map(([name]) => name);
}

/** Restrict `args` to the names tagged with `--tags`; a no-op without it. */
export async function selectTagged(
	ctx: CliContext,
	args: SecretsArgs
): Promise<void> {
	const tags = tagFilter(args);
	if (tags.length === 0) {
		return;
	}
	if (agentTarget(ctx)) {
		throw new UsageError("--tags is not supported with RYU_VAULT_TOKEN.");
	}
	const { secrets } = await listVaultSecrets(ctx.target, {
		environment: flag(args, "--env"),
		path: flag(args, "--path"),
	});
	const tagged = namesWithTags(secrets, tags);
	const named = args.values.get("--name");
	const names = named ? tagged.filter((name) => named.includes(name)) : tagged;
	if (names.length === 0) {
		ctx.io.err(
			`${tf("No values carry the tags {tags}.", { tags: tags.join(", ") })}\n`
		);
	}
	// An empty list still restricts: Core exports nothing for `names: []`.
	args.values.set("--name", names);
}

async function revokeLease(ctx: CliContext, id: string): Promise<void> {
	const agent = agentTarget(ctx);
	if (agent) {
		await vaultAgentLease(agent, id, "revoke");
	} else {
		await vaultLease(ctx.target, id, "revoke");
	}
}

async function revokeAll(
	ctx: CliContext,
	leases: VaultDynamicCredential["lease"][]
): Promise<void> {
	for (const lease of leases) {
		try {
			await revokeLease(ctx, lease.id);
		} catch {
			ctx.io.err(
				`${tf("Could not revoke lease {id}; it expires at {expiresAt}.", { id: lease.id, expiresAt: String(lease.expiresAt) })}\n`
			);
		}
	}
}

async function issue(
	ctx: CliContext,
	role: string,
	ttlSecs: number | undefined
): Promise<VaultDynamicCredential> {
	const agent = agentTarget(ctx);
	const { credential } = agent
		? await vaultAgentDynamicIssue(agent, role, ttlSecs)
		: await issueVaultDynamicCredential(ctx.target, role, ttlSecs);
	return credential;
}

/** Issue one credential per `--lease`, merging its fields into `env`. Every
 *  lease issued so far is revoked when a later one fails or collides. */
async function issueLeases(
	ctx: CliContext,
	args: SecretsArgs,
	env: Record<string, string>
): Promise<VaultDynamicCredential["lease"][]> {
	const specs = (args.values.get("--lease") ?? []).map(parseLeaseSpec);
	const rawTtl = flag(args, "--lease-ttl");
	const ttlSecs = rawTtl === undefined ? undefined : parseDuration(rawTtl);
	const leases: VaultDynamicCredential["lease"][] = [];
	try {
		for (const spec of specs) {
			const credential = await issue(ctx, spec.role, ttlSecs);
			leases.push(credential.lease);
			for (const [field, value] of Object.entries(credential.data)) {
				const variable = fieldVariable(spec.prefix, field);
				if (variable in env) {
					throw new UsageError(
						tf(
							"--lease {role} would replace {variable}, which is already set. Pick another prefix with --lease {role}=PREFIX.",
							{ role: spec.role, variable }
						)
					);
				}
				env[variable] = value;
			}
		}
	} catch (error) {
		await revokeAll(ctx, leases);
		throw error;
	}
	return leases;
}

/** Export the values, issue the leases, and build the child's environment. */
export async function prepareValueRun(
	ctx: CliContext,
	args: SecretsArgs
): Promise<PreparedRun> {
	const values = parseVaultJsonExport(await exportResult(ctx, args, "json"));
	const env: Record<string, string> = {
		...childRuntimeEnvironment(ctx.env),
		...values,
	};
	const leases = await issueLeases(ctx, args, env);
	for (const lease of leases) {
		ctx.io.err(
			`${tf("Leased {role} ({id}, expires {expiresAt}).", { role: lease.role, id: lease.id, expiresAt: String(lease.expiresAt) })}\n`
		);
	}
	return {
		env,
		leaseIds: new Set(leases.map((lease) => lease.id)),
		cleanup: () => revokeAll(ctx, leases),
	};
}

/** `prepareValueRun` with `--tags` resolved now, on a copy of `args`, so a
 *  watched run picks up tag changes on every restart instead of re-exporting
 *  the names the first run selected. */
export async function prepareTaggedRun(
	ctx: CliContext,
	args: SecretsArgs
): Promise<PreparedRun> {
	const fresh: SecretsArgs = {
		...args,
		values: new Map([...args.values].map(([key, list]) => [key, [...list]])),
	};
	await selectTagged(ctx, fresh);
	return await prepareValueRun(ctx, fresh);
}
