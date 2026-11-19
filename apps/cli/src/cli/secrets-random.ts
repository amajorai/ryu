// `ryu secrets set NAME --random [--length N] [--charset C]` - generate the
// value on this machine with a CSPRNG and record the generator in the value's
// metadata, so scheduled rotation (`--rotate-every`) keeps producing values of
// the same shape. The alphabets and the 8-256 length bound are Core's
// (`plugin_secrets/kv/metadata.rs`, `Generator::generate`). The value is
// never printed.

import { randomInt } from "node:crypto";
import type { VaultCharset, VaultGenerator } from "@ryuhq/core-client/vault";
import { localize } from "./localizedText.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { UsageError } from "./types.ts";

const LETTERS_DIGITS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const RANDOM_ALPHABETS: Readonly<Record<VaultCharset, string>> = {
	alphanumeric: LETTERS_DIGITS,
	hex: "0123456789abcdef",
	base64url: `${LETTERS_DIGITS}-_`,
	symbols: `${LETTERS_DIGITS}!#%+-.:=@^_~`,
};

const CHARSET_ALIASES = new Map<string, VaultCharset>([
	["alphanumeric", "alphanumeric"],
	["alnum", "alphanumeric"],
	["hex", "hex"],
	["base64url", "base64url"],
	["symbols", "symbols"],
]);

export const RANDOM_DEFAULT_LENGTH = 32;
const MIN_LENGTH = 8;
const MAX_LENGTH = 256;

/** A uniformly random string of `length` characters from `charset`. */
export function randomValue(length: number, charset: VaultCharset): string {
	const alphabet = RANDOM_ALPHABETS[charset];
	let value = "";
	for (let index = 0; index < length; index++) {
		value += alphabet[randomInt(alphabet.length)];
	}
	return value;
}

/** The generator `--random`, `--length`, and `--charset` describe, or
 *  undefined without `--random`. */
export function randomGeneratorFrom(
	args: SecretsArgs
): VaultGenerator | undefined {
	const random = args.booleans.has("--random");
	const rawLength = flag(args, "--length");
	const rawCharset = flag(args, "--charset");
	if (!random) {
		if (rawLength !== undefined || rawCharset !== undefined) {
			throw new UsageError(
				localize("The --length and --charset options need --random.")
			);
		}
		return;
	}
	const length =
		rawLength === undefined ? RANDOM_DEFAULT_LENGTH : Number(rawLength);
	if (
		!(Number.isInteger(length) && length >= MIN_LENGTH && length <= MAX_LENGTH)
	) {
		throw new UsageError(
			localize("The --length value must be an integer from {min} to {max}.", {
				max: MAX_LENGTH,
				min: MIN_LENGTH,
			})
		);
	}
	const charset = CHARSET_ALIASES.get(rawCharset ?? "alphanumeric");
	if (!charset) {
		throw new UsageError(
			localize(
				"The --charset value must be alphanumeric, hex, base64url, or symbols."
			)
		);
	}
	return { kind: "random", length, charset };
}
