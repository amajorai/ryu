// Argument parsing for `ryu migrate`.

import {
	ITEM_KINDS,
	type ItemKind,
	itemKindSchema,
	SOURCE_ALIASES,
	type SourceId,
	sourceIdSchema,
} from "./migrate-sources.ts";
import { UsageError } from "./types.ts";

/** Parsed `ryu migrate` options. Global flags (`--json`, `--dry-run`) come
 *  from the dispatcher; the rest are parsed from the raw argv here. */
export interface MigrateArgs {
	only: ItemKind[] | null;
	path: string | null;
	secrets: boolean;
	source: SourceId | null;
	yes: boolean;
}

export function parseMigrateArgs(rawArgs: readonly string[]): MigrateArgs {
	const parsed: MigrateArgs = {
		only: null,
		path: null,
		secrets: false,
		source: null,
		yes: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const token = rawArgs[i] ?? "";
		const [name, inline] = token.startsWith("--")
			? (token.split(/=(.*)/s, 2) as [string, string | undefined])
			: [token, undefined];
		const value = () => {
			if (inline !== undefined) {
				return inline;
			}
			i++;
			const next = rawArgs[i];
			if (next === undefined) {
				throw new UsageError(`${name} needs a value.`);
			}
			return next;
		};
		if (name === "--yes" || name === "-y") {
			parsed.yes = true;
		} else if (name === "--secrets" || name === "--migrate-secrets") {
			parsed.secrets = true;
		} else if (name === "--path" || name === "--source") {
			parsed.path = value();
		} else if (name === "--only") {
			parsed.only = parseKinds(value());
		} else if (name === "--node") {
			value();
		} else if (!token.startsWith("-")) {
			positional.push(token);
		}
	}
	const [first, second] = positional;
	if (first) {
		const source = resolveSourceId(first);
		if (source) {
			parsed.source = source;
			parsed.path ??= second ?? null;
		} else {
			parsed.path ??= first;
		}
	}
	return parsed;
}

export function resolveSourceId(token: string): SourceId | null {
	const lower = token.toLowerCase();
	const parsed = sourceIdSchema.safeParse(lower);
	if (parsed.success) {
		return parsed.data;
	}
	return SOURCE_ALIASES.get(lower) ?? null;
}

function parseKinds(raw: string): ItemKind[] {
	const kinds: ItemKind[] = [];
	for (const part of raw.split(",")) {
		const normalized = part.trim().toLowerCase().replace(/-/g, "_");
		const singular = normalized.endsWith("s")
			? normalized.slice(0, -1)
			: normalized;
		const alias =
			singular === "mcp"
				? "mcp_server"
				: singular === "chat" || singular === "conversation"
					? "conversations"
					: singular;
		const parsed = itemKindSchema.safeParse(alias);
		if (!parsed.success) {
			throw new UsageError(
				`Unknown kind "${part}". Use: ${ITEM_KINDS.join(", ")}.`
			);
		}
		kinds.push(parsed.data);
	}
	return kinds;
}
