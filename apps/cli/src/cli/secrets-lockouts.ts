// `ryu secrets lockout …`: machine-identity login lockout over Core's
// `/api/vault/sys/lockouts*` routes (admin on `sys/lockouts`). Core replaces
// the whole config on a write, so `config` with flags reads the current
// settings first and sends every field.

import {
	listVaultLockouts,
	setVaultLockoutConfig,
	unlockVaultIdentity,
	type VaultLockoutConfig,
} from "@ryuhq/core-client/vault";
import { tf, tr } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import {
	arg,
	flag,
	intFlag,
	parseDuration,
	type SecretsArgs,
} from "./secrets-args.ts";
import { printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

const USAGE =
	"Usage: ryu-cli secrets lockout list | lockout config [--threshold N] [--window 15m] [--duration 15m] [--enable|--disable] | lockout unlock IDENTITY";

function describeConfig(ctx: CliContext, config: VaultLockoutConfig): void {
	const values = {
		threshold: String(config.threshold),
		window: String(config.windowSecs),
		duration: String(config.durationSecs),
	};
	const line = config.enabled
		? tf(
				"Lockout on: {threshold} failed logins within {window}s lock an identity for {duration}s.",
				values
			)
		: tf(
				"Lockout off (threshold {threshold}, window {window}s, duration {duration}s).",
				values
			);
	ctx.io.out(`${line}\n`);
}

/** The config with the flags applied, or null when no flag was given. */
export function lockoutConfigFrom(
	args: SecretsArgs,
	current: VaultLockoutConfig
): VaultLockoutConfig | null {
	const enable = args.booleans.has("--enable");
	const disable = args.booleans.has("--disable");
	if (enable && disable) {
		throw new UsageError("Pass --enable or --disable, not both.");
	}
	const threshold = intFlag(args, "--threshold");
	if (threshold !== undefined && threshold < 1) {
		throw new UsageError("--threshold must be at least 1.");
	}
	const window = flag(args, "--window");
	const duration = flag(args, "--duration");
	if (
		!(enable || disable) &&
		threshold === undefined &&
		window === undefined &&
		duration === undefined
	) {
		return null;
	}
	return {
		enabled: enable ? true : disable ? false : current.enabled,
		threshold: threshold ?? current.threshold,
		windowSecs:
			window === undefined ? current.windowSecs : parseDuration(window),
		durationSecs:
			duration === undefined ? current.durationSecs : parseDuration(duration),
	};
}

export async function lockouts(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1] ?? "list";
	if (action === "list" || action === "ls") {
		const listing = await listVaultLockouts(ctx.target);
		if (ctx.flags.json) {
			printJson(ctx, listing);
			return 0;
		}
		describeConfig(ctx, listing.config);
		ctx.io.out(
			listing.locked.length === 0
				? `${tr("No identity is locked.")}\n`
				: `${formatTable(
						["IDENTITY", "FAILURES", "LOCKED", "UNTIL"],
						listing.locked.map((row) => [
							row.identity,
							String(row.failures),
							String(row.lockedAt),
							String(row.lockedUntil),
						])
					)}\n`
		);
		return 0;
	}
	if (action === "config") {
		const { config: current } = await listVaultLockouts(ctx.target);
		const next = lockoutConfigFrom(args, current);
		const config = next
			? (await setVaultLockoutConfig(ctx.target, next)).config
			: current;
		if (ctx.flags.json) {
			printJson(ctx, config);
		} else {
			describeConfig(ctx, config);
		}
		return 0;
	}
	if (action === "unlock") {
		const identity = arg(args, 2, "lockout unlock IDENTITY");
		const { wasLocked } = await unlockVaultIdentity(ctx.target, identity);
		if (ctx.flags.json) {
			printJson(ctx, { identity, wasLocked });
		} else {
			ctx.io.out(
				wasLocked
					? `${tf("Unlocked {identity}.", { identity })}\n`
					: `${tf("{identity} was not locked.", { identity })}\n`
			);
		}
		return 0;
	}
	throw new UsageError(USAGE);
}
