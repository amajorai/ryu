import {
	lookupVaultToken,
	renewVaultToken,
	type VaultTokenInfo,
	vaultAgentLookupSelf,
	vaultAgentRenewSelf,
	vaultAgentWrapSecret,
	vaultUnwrap,
	wrapVaultSecret,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import {
	arg,
	coordsFrom,
	flag,
	parseDuration,
	type SecretsArgs,
} from "./secrets-args.ts";
import { agentTarget, machineTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

// ── Token lifecycle and response wrapping ────────────────────────────────────

function describeToken(ctx: CliContext, token: VaultTokenInfo): void {
	ctx.io.out(
		`${formatTable(
			["ACCESSOR", "IDENTITY", "POLICIES", "EXPIRES", "TTL", "RENEWABLE"],
			[
				[
					token.accessor,
					token.identityId,
					token.policies.join(","),
					String(token.expiresAt),
					`${token.ttlSecs}s`,
					token.renewable ? "yes" : "no",
				],
			]
		)}\n`
	);
}

export async function tokenCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	const agent = agentTarget(ctx);
	const accessor = args.positional[2];
	let token: VaultTokenInfo;
	if (action === "lookup") {
		if (agent && !accessor) {
			token = (await vaultAgentLookupSelf(agent)).token;
		} else {
			token = (
				await lookupVaultToken(
					ctx.target,
					arg(args, 2, "token lookup [ACCESSOR]")
				)
			).token;
		}
	} else if (action === "renew") {
		const increment = flag(args, "--increment");
		const options =
			increment === undefined
				? {}
				: { incrementSecs: parseDuration(increment) };
		if (agent && !accessor) {
			token = (await vaultAgentRenewSelf(agent, options)).token;
		} else {
			token = (
				await renewVaultToken(
					ctx.target,
					arg(args, 2, "token renew [ACCESSOR] [--increment S]"),
					options
				)
			).token;
		}
	} else {
		throw new UsageError(
			"Usage: ryu-cli secrets token lookup [ACCESSOR] | token renew [ACCESSOR] [--increment S]"
		);
	}
	if (ctx.flags.json) {
		printJson(ctx, token);
	} else {
		describeToken(ctx, token);
	}
	return 0;
}

export async function wrap(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const name = arg(args, 1, "wrap NAME --ttl S");
	const ttl = flag(args, "--ttl");
	if (ttl === undefined) {
		throw new UsageError("Usage: ryu-cli secrets wrap NAME --ttl S (e.g. 5m)");
	}
	const agent = agentTarget(ctx);
	const { wrapInfo } = agent
		? await vaultAgentWrapSecret(
				agent,
				name,
				{ environment: flag(args, "--env"), path: flag(args, "--path") },
				ttl
			)
		: await wrapVaultSecret(ctx.target, name, coordsFrom(args), ttl);
	if (ctx.flags.json) {
		printJson(ctx, wrapInfo);
		return 0;
	}
	ctx.io.out(`${wrapInfo.token ?? ""}\n`);
	ctx.io.err(
		`${tf("Single-use wrapping token for {name}; expires {expiresAt}. Recipient: ryu-cli secrets unwrap TOKEN", { name, expiresAt: String(wrapInfo.expiresAt) })}\n`
	);
	return 0;
}

export async function unwrap(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const token = arg(args, 1, "unwrap TOKEN");
	const payload = await vaultUnwrap(machineTarget(ctx), token);
	const value = payload.value;
	if (!ctx.flags.json && typeof value === "string") {
		ctx.io.out(`${value}\n`);
		return 0;
	}
	printJson(ctx, payload);
	return 0;
}
