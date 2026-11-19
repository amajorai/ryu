// `ryu secrets ssh …`: SSH certificate authorities over Core's
// `/api/vault/ssh/cas` routes (roles, signing and revocation are in
// `secrets-ssh-certs.ts`). Creating a CA needs `admin` on
// `sys/ssh/cas/<name>`; Core generates the key and returns only its public
// half, so nothing secret is printed.

import {
	createVaultSshCa,
	listVaultSshCas,
	VAULT_SSH_CA_KEY_TYPES,
	type VaultSshCaOptions,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { localize } from "./localizedText.ts";
import { formatTable } from "./output.ts";
import { arg, flag, intFlag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { SSH_CERT_USAGE, sshCerts } from "./secrets-ssh-certs.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE = `Usage: ryu-cli secrets ssh cas | ssh ca create NAME [--key-type ed25519|rsa|ecdsa] [--key-bits N]\n${SSH_CERT_USAGE}`;

const keyTypeSchema = z.enum(VAULT_SSH_CA_KEY_TYPES);

/** `--key-type` and `--key-bits` as Core accepts them. */
export function sshCaOptions(args: SecretsArgs): VaultSshCaOptions {
	const options: VaultSshCaOptions = {};
	const keyType = flag(args, "--key-type");
	if (keyType !== undefined) {
		const parsed = keyTypeSchema.safeParse(keyType.toLowerCase());
		if (!parsed.success) {
			throw new UsageError(
				localize("The --key-type value must be one of {choices}.", {
					choices: VAULT_SSH_CA_KEY_TYPES.join(", "),
				})
			);
		}
		options.keyType = parsed.data;
	}
	const keyBits = intFlag(args, "--key-bits");
	if (keyBits !== undefined) {
		if (!options.keyType || options.keyType === "ed25519") {
			throw new UsageError(
				"--key-bits needs --key-type rsa (2048, 3072, 4096) or ecdsa (256, 384)."
			);
		}
		options.keyBits = keyBits;
	}
	return options;
}

export async function ssh(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const [, action, verb] = args.positional;
	if (action === "cas" || (action === "ca" && (verb ?? "list") === "list")) {
		const { cas } = await listVaultSshCas(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, cas);
		} else {
			ctx.io.out(
				`${formatTable(
					["NAME", "PUBLIC KEY"],
					cas.map((ca) => [ca.name, ca.publicKey])
				)}\n`
			);
		}
		return 0;
	}
	if (action === "ca" && verb === "create") {
		const name = arg(args, 3, "ssh ca create NAME [--key-type T]");
		const { publicKey } = await createVaultSshCa(
			ctx.target,
			name,
			sshCaOptions(args)
		);
		if (ctx.flags.json) {
			printJson(ctx, { name, publicKey });
		} else {
			ctx.io.out(`${publicKey}\n`);
		}
		return 0;
	}
	const handled = await sshCerts(ctx, args);
	if (handled !== null) {
		return handled;
	}
	throw new UsageError(USAGE);
}
