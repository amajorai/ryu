// `ryu secrets identity …`: workload identity tokens over Core's
// `/api/vault/identity/*` routes. `config` reads and sets the issuer, key
// rotation period and signing algorithm (admin; Core replaces the whole
// config, so a change reads it first and sends every field). `token` mints a
// JWT for a role (with `RYU_VAULT_TOKEN`, as that machine). `verify` checks a
// token against the public JWKS, as a relying party would; Core has no
// verify route.

import {
	getVaultIdentityConfig,
	getVaultIdentityJwks,
	mintVaultIdentityToken,
	setVaultIdentityConfig,
	VAULT_IDENTITY_SIGNING_ALGORITHMS,
	type VaultIdentityConfig,
	type VaultIdentitySigningAlgorithm,
	vaultAgentIdentityToken,
	verifyVaultIdentityToken,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { localize } from "./localizedText.ts";
import { arg, flag, parseDuration, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget, machineTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE =
	"Usage: ryu-cli secrets identity config [--issuer URL] [--algorithm ES256|RS256|EdDSA] [--rotation-period 30d] | identity token ROLE | identity verify [TOKEN|-] [--algorithm A] [--audience AUD] [--issuer URL]";

/** `--algorithm`, matched without case to the names Core uses. */
export function signingAlgorithm(
	args: SecretsArgs
): VaultIdentitySigningAlgorithm | undefined {
	const value = flag(args, "--algorithm");
	if (value === undefined) {
		return undefined;
	}
	const match = VAULT_IDENTITY_SIGNING_ALGORITHMS.find(
		(algorithm) => algorithm.toLowerCase() === value.toLowerCase()
	);
	if (!match) {
		throw new UsageError(
			localize("The --algorithm value must be one of {choices}.", {
				choices: VAULT_IDENTITY_SIGNING_ALGORITHMS.join(", "),
			})
		);
	}
	return match;
}

/** The config with the flags applied, or null when no flag was given. */
export function identityConfigFrom(
	args: SecretsArgs,
	current: VaultIdentityConfig
): VaultIdentityConfig | null {
	const issuer = flag(args, "--issuer");
	const rotation = flag(args, "--rotation-period");
	const algorithm = signingAlgorithm(args);
	if (
		issuer === undefined &&
		rotation === undefined &&
		algorithm === undefined
	) {
		return null;
	}
	const next: VaultIdentityConfig = {
		issuer: issuer ?? current.issuer,
		rotationPeriodSecs:
			rotation === undefined
				? current.rotationPeriodSecs
				: parseDuration(rotation),
	};
	const signing = algorithm ?? current.signingAlgorithm;
	if (signing) {
		next.signingAlgorithm = signing;
	}
	return next;
}

async function config(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const { config: current } = await getVaultIdentityConfig(ctx.target);
	const next = identityConfigFrom(args, current);
	const shown = next
		? (await setVaultIdentityConfig(ctx.target, next)).config
		: current;
	if (ctx.flags.json) {
		printJson(ctx, shown);
		return 0;
	}
	ctx.io.out(
		`${tf(
			"Issuer {issuer}, signing {algorithm}, key rotated every {rotation}s.",
			{
				issuer: shown.issuer ?? "-",
				algorithm: shown.signingAlgorithm ?? "ES256",
				rotation: String(shown.rotationPeriodSecs),
			}
		)}\n`
	);
	return 0;
}

async function token(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const role = arg(args, 2, "identity token ROLE");
	const agent = agentTarget(ctx);
	const minted = agent
		? await vaultAgentIdentityToken(agent, role)
		: await mintVaultIdentityToken(ctx.target, role);
	if (ctx.flags.json) {
		printJson(ctx, minted.token);
	} else {
		ctx.io.out(`${minted.token.token}\n`);
	}
	return 0;
}

async function verify(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const given = args.positional[2];
	const jwt = (
		given && given !== "-" ? given : ((await ctx.readStdin()) ?? "")
	).trim();
	if (!jwt) {
		throw new UsageError(
			"Usage: ryu-cli secrets identity verify TOKEN (or pipe it on stdin)"
		);
	}
	const jwks = await getVaultIdentityJwks(machineTarget(ctx));
	const check: Parameters<typeof verifyVaultIdentityToken>[2] = {};
	const algorithm = signingAlgorithm(args);
	const audience = flag(args, "--audience");
	const issuer = flag(args, "--issuer");
	if (algorithm) {
		check.algorithm = algorithm;
	}
	if (audience !== undefined) {
		check.audience = audience;
	}
	if (issuer !== undefined) {
		check.issuer = issuer;
	}
	const result = await verifyVaultIdentityToken(jwt, jwks, check);
	if (ctx.flags.json) {
		printJson(ctx, result);
	} else if (result.valid) {
		ctx.io.out(
			`${tf("Valid {algorithm} token (key {kid}).", {
				algorithm: result.algorithm,
				kid: result.kid,
			})}\n${JSON.stringify(result.claims, null, 2)}\n`
		);
	} else {
		ctx.io.err(
			`${tf("Invalid token: {reason}.", { reason: result.reason })}\n`
		);
	}
	return result.valid ? 0 : 1;
}

export function identity(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const action = args.positional[1];
	if (action === "config") {
		return config(ctx, args);
	}
	if (action === "token") {
		return token(ctx, args);
	}
	if (action === "verify") {
		return verify(ctx, args);
	}
	throw new UsageError(USAGE);
}
