// `ryu-cli secrets rekey …`: replace the Shamir key shares, like
// `bao operator rekey`. Every action needs `admin` on `sys/rekey`.
//
// `update` reads one current key share from stdin, never from an argument
// (arguments show up in `ps` and shell history). The update that completes
// the rekey prints the new shares exactly once, so the agent guard refuses
// `update` in an AI agent session (`printsSecretValues`).
//
// Core returns the new shares once, after the old root is replaced, so
// output that is lost then (a closed pipe) loses them. `--out FILE` is
// checked before the share is submitted and gets the shares owner-only
// (0600); if writing it fails anyway, the shares go to stdout instead.

import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	cancelVaultRekey,
	getVaultRekey,
	initVaultRekey,
	updateVaultRekey,
	type VaultRekeyStatus,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { flag, intFlag, type SecretsArgs } from "./secrets-args.ts";
import {
	checkOutParent,
	createExclusive,
	writeFailure,
} from "./secrets-out-file.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE =
	"Usage: ryu-cli secrets rekey [status] | rekey init [--shares N] [--threshold T] | rekey update [--nonce N] [--out FILE] (current share on stdin) | rekey cancel";

/** One line describing a rekey's progress. */
export function rekeyLine(status: VaultRekeyStatus): string {
	if (!status.started) {
		return tr("No rekey is in progress.");
	}
	return tf(
		"Rekey to {shares} shares (threshold {threshold}): {progress}/{required} current shares submitted. Nonce: {nonce}",
		{
			nonce: status.nonce ?? "",
			progress: status.progress,
			required: status.required,
			shares: status.newShares,
			threshold: status.newThreshold,
		}
	);
}

/** `--shares` and `--threshold` as Core accepts them: 2 ≤ T ≤ N ≤ 255. */
export function rekeyShape(args: SecretsArgs): {
	shares?: number;
	threshold?: number;
} {
	const shares = intFlag(args, "--shares");
	const threshold = intFlag(args, "--threshold");
	const n = shares ?? 5;
	const t = threshold ?? 3;
	if (!(n <= 255 && t >= 2 && t <= n)) {
		throw new UsageError(
			"--threshold must be at least 2 and at most --shares, and --shares at most 255."
		);
	}
	return {
		...(shares === undefined ? {} : { shares }),
		...(threshold === undefined ? {} : { threshold }),
	};
}

/** `--out` for the new shares: a new path only (a file, or a symlink to
 *  one, is never replaced), checked before the share is submitted. */
async function sharesPath(
	ctx: CliContext,
	file: string | undefined
): Promise<string | undefined> {
	if (file === undefined) {
		return undefined;
	}
	const path = isAbsolute(file) ? file : join(ctx.cwd ?? process.cwd(), file);
	if (await lstat(path).catch(() => null)) {
		throw new UsageError(
			tf("{file} already exists; the new shares go only to a new file.", {
				file,
			})
		);
	}
	await checkOutParent(path, file);
	return path;
}

async function currentShare(ctx: CliContext): Promise<string> {
	const piped = await ctx.readStdin();
	const share = piped?.trim() ?? "";
	if (!share) {
		throw new UsageError(
			"rekey update reads one current key share from stdin; pipe it in."
		);
	}
	return share;
}

function show(ctx: CliContext, status: VaultRekeyStatus): number {
	if (ctx.flags.json) {
		printJson(ctx, status);
	} else {
		ctx.io.out(`${rekeyLine(status)}\n`);
	}
	return 0;
}

export async function rekey(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "status";
	switch (action) {
		case "status":
			return show(ctx, (await getVaultRekey(ctx.target)).rekey);
		case "init":
			return show(
				ctx,
				(await initVaultRekey(ctx.target, rekeyShape(args))).rekey
			);
		case "cancel":
			return show(ctx, (await cancelVaultRekey(ctx.target)).rekey);
		case "update": {
			// A share on the command line shows up in `ps` and shell history.
			if (args.positional.length > 2 || args.passthrough !== null) {
				throw new UsageError(
					"rekey update never takes a share as an argument; pipe it in on stdin."
				);
			}
			const out = flag(args, "--out");
			const path = await sharesPath(ctx, out);
			const share = await currentShare(ctx);
			const nonce =
				flag(args, "--nonce") ?? (await getVaultRekey(ctx.target)).rekey.nonce;
			if (!nonce) {
				throw new UsageError(
					"No rekey is in progress; start one with 'ryu-cli secrets rekey init'."
				);
			}
			const update = await updateVaultRekey(ctx.target, { nonce, share });
			const shares = update.complete ? update.shares : undefined;
			if (shares === undefined) {
				if (ctx.flags.json) {
					printJson(ctx, update);
				} else {
					ctx.io.out(`${rekeyLine(update.status)}\n`);
				}
				return 0;
			}
			ctx.io.err(
				`${tr("Rekey complete. The old shares no longer unseal the vault. Store each new share separately: they are not shown again.")}\n`
			);
			if (path !== undefined && out !== undefined) {
				try {
					await createExclusive(path, `${shares.join("\n")}\n`, 0o600);
					ctx.io.err(
						`${tf("Wrote the new shares to {file}.", { file: out })}\n`
					);
					return 0;
				} catch (error) {
					const reason = writeFailure(error);
					ctx.io.err(
						`${tf("The new shares could not be written to {file}: {reason}. They are printed below instead; store them now.", { file: out, reason })}\n`
					);
					if (ctx.flags.json) {
						printJson(ctx, { ...update, written: false });
					} else {
						ctx.io.out(`${shares.join("\n")}\n`);
					}
					return 1;
				}
			}
			if (ctx.flags.json) {
				printJson(ctx, update);
			} else {
				ctx.io.out(`${shares.join("\n")}\n`);
			}
			return 0;
		}
		default:
			throw new UsageError(USAGE);
	}
}
