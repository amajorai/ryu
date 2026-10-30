import {
	getVaultItem,
	getVaultTotpCode,
	listVaultItems,
	putVaultCard,
	type VaultItemFieldInput,
	type VaultItemFieldType,
	type VaultItemLocation,
	validateVaultTotpCode,
	vaultAgentTotpCode,
	vaultAgentTotpValidate,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";
import { formatTable } from "./output.ts";
import { arg, flag, type SecretsArgs } from "./secrets-args.ts";
import { agentTarget, printJson } from "./secrets-output.ts";
import { type CliContext, UsageError } from "./types.ts";

// ── TOTP ─────────────────────────────────────────────────────────────────────

export async function totp(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const action = args.positional[1];
	const agent = agentTarget(ctx);
	if (action === "code") {
		const name = arg(args, 2, "totp code NAME");
		const code = agent
			? await vaultAgentTotpCode(agent, name)
			: await getVaultTotpCode(ctx.target, name);
		if (ctx.flags.json) {
			printJson(ctx, code);
		} else {
			ctx.io.out(`${code.code}\n`);
			ctx.io.err(
				`${tf("Valid for {remainingSecs}s.", { remainingSecs: String(code.remainingSecs) })}\n`
			);
		}
		return 0;
	}
	if (action === "validate") {
		const usage = "totp validate NAME CODE";
		const name = arg(args, 2, usage);
		const code = arg(args, 3, usage);
		const { valid } = agent
			? await vaultAgentTotpValidate(agent, name, code)
			: await validateVaultTotpCode(ctx.target, name, code);
		if (ctx.flags.json) {
			printJson(ctx, { valid });
		} else {
			ctx.io.out(valid ? "valid\n" : "invalid\n");
		}
		return valid ? 0 : 1;
	}
	throw new UsageError(
		"Usage: ryu-cli secrets totp code NAME | totp validate NAME CODE"
	);
}

// ── Typed items ──────────────────────────────────────────────────────────────

const ITEM_FIELD_TYPES: readonly VaultItemFieldType[] = [
	"text",
	"email",
	"url",
	"password",
	"totp",
	"note",
];
const PLAIN_SUFFIX = ":plain";

/** `--field name=value[:plain]`. A name that is a field type (`email`, `url`,
 *  `totp`, …) uses that type; otherwise the field is a sensitive `password`,
 *  or non-sensitive `text` with `:plain`. */
export function parseItemField(spec: string): {
	field: VaultItemFieldInput;
	value: string;
} {
	const eq = spec.indexOf("=");
	const name = eq === -1 ? "" : spec.slice(0, eq).trim();
	if (!name) {
		throw new UsageError(
			`Invalid --field '${spec}'. Use --field name=value[:plain].`
		);
	}
	let value = spec.slice(eq + 1);
	const plain = value.endsWith(PLAIN_SUFFIX);
	if (plain) {
		value = value.slice(0, -PLAIN_SUFFIX.length);
	}
	const named = ITEM_FIELD_TYPES.find((type) => type === name);
	const type: VaultItemFieldType = named ?? (plain ? "text" : "password");
	return { field: { name, type, sensitive: !plain }, value };
}

export function itemLocation(args: SecretsArgs): VaultItemLocation {
	const location: VaultItemLocation = {};
	const environment = flag(args, "--env");
	const path = flag(args, "--path");
	if (environment) {
		location.environment = environment;
	}
	if (path) {
		location.path = path;
	}
	return location;
}

export async function itemsList(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const { items } = await listVaultItems(ctx.target, itemLocation(args));
	if (ctx.flags.json) {
		printJson(ctx, items);
		return 0;
	}
	if (items.length === 0) {
		ctx.io.out("No items.\n");
		return 0;
	}
	const rows = items.map((item) => [
		item.key,
		item.environment,
		item.path,
		item.kind,
		String(item.version),
		item.status,
		String(item.fieldCount),
	]);
	ctx.io.out(
		`${formatTable(["KEY", "ENV", "PATH", "TYPE", "VERSION", "STATUS", "FIELDS"], rows)}\n`
	);
	return 0;
}

export async function itemsGet(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const key = arg(args, 2, "items get KEY");
	const { item } = await getVaultItem(ctx.target, key, itemLocation(args));
	if (ctx.flags.json) {
		printJson(ctx, item);
		return 0;
	}
	ctx.io.out(
		`${item.key} (${item.kind}, version ${item.version}, ${item.status})\n`
	);
	const rows = item.fields.map((field) => {
		let shown = "(empty)";
		if (field.value !== undefined) {
			shown = field.value;
		} else if (field.hasValue) {
			shown = "(hidden)";
		}
		return [field.name, field.type, field.sensitive ? "yes" : "no", shown];
	});
	ctx.io.out(`${formatTable(["FIELD", "TYPE", "SENSITIVE", "VALUE"], rows)}\n`);
	return 0;
}

const CARD_PUT_USAGE =
	'Usage: printf \'%s\\n%s\\n\' "$NUMBER" "$CVC" | ryu-cli secrets items put KEY --type card --cardholder NAME --exp MM/YY --merchant HOST…';

/** `MM/YY` or `MM/YYYY`. */
export function parseCardExpiry(value: string): {
	expMonth: string;
	expYear: string;
} {
	const match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(value.trim());
	if (!(match?.[1] && match[2])) {
		throw new UsageError("--exp must be MM/YY or MM/YYYY.");
	}
	return { expMonth: match[1], expYear: match[2] };
}

/** The number (first line) and optional CVC (second line) from stdin. */
export function parseCardStdin(text: string): { cvc?: string; number: string } {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const [number, cvc, ...rest] = lines;
	if (!number || rest.length > 0) {
		throw new UsageError(
			"stdin must hold the card number on the first line and, optionally, the CVC on the second."
		);
	}
	return cvc === undefined ? { number } : { number, cvc };
}

const CARD_BILLING_FLAGS = [
	["--postal-code", "postalCode"],
	["--country", "country"],
	["--address-line1", "addressLine1"],
	["--address-line2", "addressLine2"],
	["--city", "city"],
	["--region", "region"],
] as const;

export async function itemsPutCard(
	ctx: CliContext,
	args: SecretsArgs,
	key: string
): Promise<number> {
	if (args.values.has("--field")) {
		throw new UsageError(
			"Card items have a fixed schema; use --cardholder, --exp, and billing flags instead of --field."
		);
	}
	const cardholder = flag(args, "--cardholder");
	const exp = flag(args, "--exp");
	const merchants = args.values.get("--merchant") ?? [];
	if (!(cardholder && exp) || merchants.length === 0) {
		throw new UsageError(CARD_PUT_USAGE);
	}
	const piped = await ctx.readStdin();
	if (piped === null) {
		throw new UsageError(
			`The card number and CVC are read from stdin, which is a terminal. ${CARD_PUT_USAGE}`
		);
	}
	const { number, cvc } = parseCardStdin(piped);
	const input: Parameters<typeof putVaultCard>[2] = {
		...itemLocation(args),
		cardholder,
		number,
		...parseCardExpiry(exp),
		merchants,
	};
	if (cvc !== undefined) {
		input.cvc = cvc;
	}
	for (const [name, field] of CARD_BILLING_FLAGS) {
		const value = flag(args, name);
		if (value !== undefined) {
			input[field] = value;
		}
	}
	const description = flag(args, "--description");
	if (description !== undefined) {
		input.description = description;
	}
	const { item } = await putVaultCard(ctx.target, key, input);
	if (ctx.flags.json) {
		printJson(ctx, item);
	} else {
		const brand = item.card?.brand ?? "card";
		const last4 = item.card?.last4 ?? "????";
		ctx.io.out(
			`${tf("Stored card {key} ({brand} ending {last4}, version {version}).", { key: item.key, brand, last4, version: String(item.version) })}\n`
		);
	}
	return 0;
}
