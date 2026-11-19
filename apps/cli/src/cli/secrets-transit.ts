// `ryu-cli secrets transit …`: encryption as a service over Core's
// `/api/vault/transit` routes, like `bao write transit/…`.
//
// Text arguments (plaintext, input, context) are UTF-8 and encoded here;
// sensitive plaintext should come from stdin (`-` or omitted), since an
// argument shows up in `ps` and shell history;
// `--base64` says they are base64 already. `decrypt` prints the plaintext
// as text (`--base64` keeps it encoded). `decrypt` and `datakey` print key
// material or plaintext, so the agent guard refuses them in an AI agent
// session (`printsSecretValues`). Ciphertext, signatures and HMACs are not
// secret.

import {
	createVaultTransitKey,
	deleteVaultTransitKey,
	listVaultTransitKeys,
	type VaultTransitOpOptions,
	vaultTransit,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, flag, intFlag, type SecretsArgs } from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

export const BASE64_FLAG = "--base64";

const USAGE = [
	"Usage: ryu-cli secrets transit keys",
	"  | transit key create NAME [--type T] | key rotate NAME | key delete NAME",
	"  | transit encrypt KEY [TEXT|-] | decrypt KEY CIPHERTEXT | rewrap KEY CIPHERTEXT",
	"  | transit sign KEY [TEXT|-] | hmac KEY [TEXT|-] | datakey KEY",
	"  | transit verify KEY [TEXT|-] (--signature S | --hmac H)",
	"  [--context C] [--key-version N] [--associated-data A] [--signature-algorithm pss|pkcs1v15] [--base64]",
].join("\n");

function toBase64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/** A text flag or argument as Core takes it: base64. */
export function encoded(args: SecretsArgs, value: string): string {
	if (!args.booleans.has(BASE64_FLAG)) {
		return toBase64(value);
	}
	// `base64` wraps long output at 76 columns: whitespace is not data.
	const compact = value.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
		throw new UsageError("With --base64, the text must be standard base64.");
	}
	return compact;
}

/** The shared operation options from flags. */
export function transitOptions(args: SecretsArgs): VaultTransitOpOptions {
	const options: VaultTransitOpOptions = {};
	const context = flag(args, "--context");
	if (context !== undefined) {
		options.context = encoded(args, context);
	}
	const associated = flag(args, "--associated-data");
	if (associated !== undefined) {
		options.associatedData = encoded(args, associated);
	}
	const version = intFlag(args, "--key-version");
	if (version !== undefined) {
		if (version < 1) {
			throw new UsageError("--key-version must be 1 or more.");
		}
		options.keyVersion = version;
	}
	const algorithm = flag(args, "--signature-algorithm");
	if (algorithm !== undefined) {
		if (algorithm !== "pss" && algorithm !== "pkcs1v15") {
			throw new UsageError("--signature-algorithm must be pss or pkcs1v15.");
		}
		options.signatureAlgorithm = algorithm;
	}
	return options;
}

/** TEXT from the argument at `index`, or stdin when it is `-` or omitted. */
async function inputText(
	ctx: CliContext,
	args: SecretsArgs,
	index: number
): Promise<string> {
	const given = args.positional[index];
	if (given !== undefined && given !== "-") {
		return given;
	}
	const piped = await ctx.readStdin();
	if (piped === null) {
		throw new UsageError(
			"Pass the text as an argument, or pipe it in (stdin is a terminal)."
		);
	}
	return piped.replace(/\r?\n$/, "");
}

function print(ctx: CliContext, value: unknown, text: string): number {
	if (ctx.flags.json) {
		printJson(ctx, value);
	} else {
		ctx.io.out(`${text}\n`);
	}
	return 0;
}

async function keys(ctx: CliContext, args: SecretsArgs): Promise<number> {
	const [, , verb] = args.positional;
	if (verb === undefined || verb === "list") {
		const { keys: list } = await listVaultTransitKeys(ctx.target);
		const rows = list.map((key) => [
			key.name,
			key.type,
			String(key.latestVersion),
			String(key.minDecryptionVersion),
		]);
		return print(
			ctx,
			list,
			formatTable(["NAME", "TYPE", "LATEST", "MIN DECRYPT"], rows)
		);
	}
	const name = arg(args, 3, `transit key ${verb} NAME`);
	if (verb === "create") {
		const type = flag(args, "--type");
		const { key } = await createVaultTransitKey(ctx.target, {
			name,
			...(type ? { type } : {}),
		});
		return print(ctx, key, `${key.name} (${key.type}) v${key.latestVersion}`);
	}
	if (verb === "rotate") {
		const { key } = await vaultTransit(ctx.target, "rotate", name, {});
		return print(ctx, key, `${key.name} v${key.latestVersion}`);
	}
	if (verb === "delete") {
		const result = await deleteVaultTransitKey(ctx.target, name);
		return print(
			ctx,
			result,
			result.deleted ? tf("Deleted {name}.", { name }) : name
		);
	}
	throw new UsageError(USAGE);
}

export async function transit(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	if (action === "keys" || action === "key") {
		return await keys(ctx, args);
	}
	if (action === undefined) {
		throw new UsageError(USAGE);
	}
	const name = arg(args, 2, `transit ${action} KEY`);
	const options = transitOptions(args);
	switch (action) {
		case "encrypt": {
			const plaintext = encoded(args, await inputText(ctx, args, 3));
			const result = await vaultTransit(ctx.target, "encrypt", name, {
				...options,
				plaintext,
			});
			return print(ctx, result, result.ciphertext);
		}
		case "decrypt": {
			const ciphertext = arg(args, 3, "transit decrypt KEY CIPHERTEXT");
			const result = await vaultTransit(ctx.target, "decrypt", name, {
				...options,
				ciphertext,
			});
			const text = args.booleans.has(BASE64_FLAG)
				? result.plaintext
				: Buffer.from(result.plaintext, "base64").toString("utf8");
			return print(ctx, result, text);
		}
		case "rewrap": {
			const ciphertext = arg(args, 3, "transit rewrap KEY CIPHERTEXT");
			const result = await vaultTransit(ctx.target, "rewrap", name, {
				...options,
				ciphertext,
			});
			return print(ctx, result, result.ciphertext);
		}
		case "sign": {
			const input = encoded(args, await inputText(ctx, args, 3));
			const result = await vaultTransit(ctx.target, "sign", name, {
				...options,
				input,
			});
			return print(ctx, result, result.signature);
		}
		case "hmac": {
			const input = encoded(args, await inputText(ctx, args, 3));
			const result = await vaultTransit(ctx.target, "hmac", name, {
				...options,
				input,
			});
			return print(ctx, result, result.hmac);
		}
		case "verify": {
			const signature = flag(args, "--signature");
			const hmac = flag(args, "--hmac");
			if ((signature === undefined) === (hmac === undefined)) {
				throw new UsageError(
					"transit verify needs one of --signature or --hmac."
				);
			}
			const input = encoded(args, await inputText(ctx, args, 3));
			const result = await vaultTransit(ctx.target, "verify", name, {
				...options,
				input,
				...(signature === undefined ? {} : { signature }),
				...(hmac === undefined ? {} : { hmac }),
			});
			print(ctx, result, result.valid ? tr("valid") : tr("invalid"));
			return result.valid ? 0 : 1;
		}
		case "datakey": {
			const result = await vaultTransit(ctx.target, "datakey", name, options);
			return print(
				ctx,
				result,
				`plaintext  ${result.plaintext}\nciphertext ${result.ciphertext}`
			);
		}
		default:
			throw new UsageError(USAGE);
	}
}
