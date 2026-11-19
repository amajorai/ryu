// `ryu secrets login`: exchange a machine credential for a short-lived vault
// token and print it. AppRole and OIDC/JWT send their credential as given;
// `--cert` signs a proof-of-possession JWT with the certificate's key,
// `--aws` signs an `sts:GetCallerIdentity` request with the AWS credentials in
// the environment, and `--k8s` sends the pod's service-account token.
// `--azure` and `--gcp` fetch the workload's OIDC token from the cloud
// metadata service and log in through JWT auth (`secrets-login-cloud.ts`).
// Private keys and AWS secrets never leave this process. `--no-store -- CMD`
// hands the token to one command instead of printing it, then revokes it.

import { readFile } from "node:fs/promises";
import {
	type VaultIssuedToken,
	vaultAgentRevokeSelf,
	vaultAppRoleLogin,
	vaultAwsLogin,
	vaultCertLogin,
	vaultJwtLogin,
	vaultKubernetesLogin,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { localize } from "./localizedText.ts";
import { arg, flag, type SecretsArgs } from "./secrets-args.ts";
import {
	azureManagedIdentityJwt,
	gcpIdentityJwt,
} from "./secrets-login-cloud.ts";
import {
	awsCredentialsFromEnv,
	awsLoginRequest,
	certLoginProof,
} from "./secrets-login-proofs.ts";
import { machineTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const K8S_TOKEN_PATH =
	"/var/run/secrets/kubernetes.io/serviceaccount/token";

const LOGIN_USAGE =
	"Usage: ryu-cli secrets login --approle ROLE_ID SECRET_ID | --jwt IDENTITY JWT | --cert IDENTITY --cert-file PEM --key-file PEM | --aws IDENTITY --server-id ID [--sts-endpoint URL] [--region R] | --k8s IDENTITY [--jwt-file PATH] | --azure IDENTITY [--resource URI] [--client-id ID] | --gcp IDENTITY [--audience AUD]; add --no-store -- CMD… to run one command with the token instead of printing it";

async function readNamedFile(path: string, name: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		throw new UsageError(
			tf("Could not read {name} {path}: {reason}", {
				name,
				path,
				reason: error instanceof Error ? error.message : String(error),
			})
		);
	}
}

function requiredFlag(args: SecretsArgs, name: string): string {
	const value = flag(args, name);
	if (!value) {
		throw new UsageError(LOGIN_USAGE);
	}
	return value;
}

async function exchange(
	ctx: CliContext,
	args: SecretsArgs
): Promise<{ token: VaultIssuedToken }> {
	const target = machineTarget(ctx);
	if (args.booleans.has("--approle")) {
		return await vaultAppRoleLogin(target, {
			roleId: arg(args, 1, "login --approle ROLE_ID SECRET_ID"),
			secretId: arg(args, 2, "login --approle ROLE_ID SECRET_ID"),
		});
	}
	if (args.booleans.has("--jwt")) {
		return await vaultJwtLogin(target, {
			identity: arg(args, 1, "login --jwt IDENTITY JWT"),
			jwt: arg(args, 2, "login --jwt IDENTITY JWT"),
		});
	}
	if (args.booleans.has("--cert")) {
		const identity = arg(
			args,
			1,
			"login --cert IDENTITY --cert-file PEM --key-file PEM"
		);
		const certificatePem = await readNamedFile(
			requiredFlag(args, "--cert-file"),
			"--cert-file"
		);
		const keyPem = await readNamedFile(
			requiredFlag(args, "--key-file"),
			"--key-file"
		);
		return await vaultCertLogin(target, {
			identity,
			certificatePem,
			proof: certLoginProof(keyPem, identity),
		});
	}
	if (args.booleans.has("--aws")) {
		const identity = arg(args, 1, "login --aws IDENTITY --server-id ID");
		const endpoint = flag(args, "--sts-endpoint");
		const region = flag(args, "--region");
		return await vaultAwsLogin(
			target,
			awsLoginRequest({
				identity,
				serverId: requiredFlag(args, "--server-id"),
				credentials: awsCredentialsFromEnv(ctx.env),
				...(endpoint ? { endpoint } : {}),
				...(region ? { region } : {}),
			})
		);
	}
	if (args.booleans.has("--azure")) {
		const identity = arg(args, 1, "login --azure IDENTITY [--resource URI]");
		const clientId = flag(args, "--client-id");
		const resource = flag(args, "--resource");
		const jwt = await azureManagedIdentityJwt(ctx.fetch, ctx.env, {
			...(clientId ? { clientId } : {}),
			...(resource ? { resource } : {}),
		});
		return await vaultJwtLogin(target, { identity, jwt });
	}
	if (args.booleans.has("--gcp")) {
		const identity = arg(args, 1, "login --gcp IDENTITY [--audience AUD]");
		const audience =
			flag(args, "--audience") ?? ctx.target.url.replace(/\/+$/, "");
		const jwt = await gcpIdentityJwt(ctx.fetch, audience);
		return await vaultJwtLogin(target, { identity, jwt });
	}
	if (args.booleans.has("--k8s")) {
		const identity = arg(args, 1, "login --k8s IDENTITY [--jwt-file PATH]");
		const jwt = (
			await readNamedFile(
				flag(args, "--jwt-file") ?? K8S_TOKEN_PATH,
				"--jwt-file"
			)
		).trim();
		return await vaultKubernetesLogin(target, { identity, jwt });
	}
	throw new UsageError(LOGIN_USAGE);
}

/** `login … --no-store -- CMD…` - the token goes only into CMD's
 *  `RYU_VAULT_TOKEN`, is never printed, and is revoked when CMD exits. */
async function loginForCommand(
	ctx: CliContext,
	args: SecretsArgs,
	command: string[]
): Promise<number> {
	const { token } = await exchange(ctx, args);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(ctx.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env.RYU_VAULT_TOKEN = token.token;
	ctx.io.err(
		`${tf("ryu: running {command} with a vault token for {identityId}; it is revoked when the command exits.", { command: command[0] ?? "", identityId: token.identityId })}\n`
	);
	try {
		return await ctx.spawn(command, env);
	} finally {
		try {
			await vaultAgentRevokeSelf({
				...machineTarget(ctx),
				vaultToken: token.token,
			});
		} catch {
			ctx.io.err(
				`${tf("Could not revoke the vault token (accessor {accessor}); it expires {expiresAt}.", { accessor: token.accessor, expiresAt: String(token.expiresAt) })}\n`
			);
		}
	}
}

export async function login(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const noStore = args.booleans.has("--no-store");
	const command = args.passthrough ?? [];
	if (noStore !== command.length > 0) {
		throw new UsageError(
			localize("Use --no-store to run one command with the token: {usage}", {
				usage: "ryu-cli secrets login <method> … --no-store -- CMD ARGS…",
			})
		);
	}
	if (noStore) {
		return await loginForCommand(ctx, args, command);
	}
	const result = await exchange(ctx, args);
	if (ctx.flags.json) {
		printJson(ctx, result.token);
		return 0;
	}
	ctx.io.out(`${result.token.token}\n`);
	ctx.io.err(
		`${tf("Vault token for {identityId} expires {expiresAt}. Export it as RYU_VAULT_TOKEN.", { identityId: result.token.identityId, expiresAt: String(result.token.expiresAt) })}\n`
	);
	ctx.io.err(
		`${tf("Vault/OpenBao CLIs work too (Ryu serves the /v1 API): export VAULT_ADDR={address} VAULT_TOKEN=<this token>", { address: ctx.target.url.replace(/\/+$/, "") })}\n`
	);
	return 0;
}
