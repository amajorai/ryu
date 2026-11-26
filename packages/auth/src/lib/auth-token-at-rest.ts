import {
	createHmac,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import {
	digestToken,
	isSealed,
	isTokenDigest,
	open,
	seal,
	tokenLookupCandidates,
} from "@ryu/db/crypto";
import { z } from "zod";
import {
	type AuthRequestScope,
	currentAuthRequestScope,
} from "./auth-request-scope.ts";

/**
 * At-rest protection for the Better Auth rows that hold credentials, applied
 * at the adapter boundary (`wrapSsoProviderAdapter`), so every Better Auth
 * route and plugin, and every Ryu caller of `internalAdapter`, goes through it.
 *
 * - `account.accessToken | refreshToken | idToken` (social and SSO OAuth
 *   tokens) are sealed with the Cloud `enc:v1:` envelope (`@ryu/db/crypto`,
 *   `RYU_DB_MASTER_KEY`) on write and opened on read. Legacy plaintext rows
 *   read as-is and are sealed on their next write (token refresh, relink) or
 *   by the boot migration.
 * - `session.token` is a bearer credential that Better Auth looks up by
 *   equality, so it is stored as `sha256:<hex>` (`digestToken`) and every
 *   `where token = X` is rewritten to the digest. The raw token lives only in
 *   the signed cookie or the client's bearer store.
 * - `deviceCode.deviceCode` (RFC 8628 device_code) is stored as a digest the
 *   same way; nothing reads it back.
 *
 * Session rows found by something other than their token (listSessions,
 * admin listings) cannot return the raw token any more. They return an opaque
 * handle `rsh1.<digest>.<mac>` instead, where the MAC is keyed from the Better
 * Auth secret: the adapter accepts a handle wherever it accepts a token
 * (revoke, multi session) but a handle cannot be forged from a database dump,
 * which holds only the digest, and it is no credential: the bearer plugin
 * refuses it and a cookie needs the server's signature.
 *
 * A raw token is handed back only to the request that presented it. The memo
 * that maps a digest back to its token hangs on the scope of the Better Auth
 * call in progress (`auth-request-scope.ts`), so the caller's own session in
 * a listing still compares equal to `ctx.context.session.session.token`
 * (Better Auth's revoke-other-sessions filter relies on that), while every
 * other session of the account, however recently used, reads as a handle.
 * It was one map for the whole process once, and any session of an account
 * could then list the live bearer tokens of the others.
 */

type AuthRecord = Record<string, unknown>;
const recordSchema = z.record(z.string(), z.unknown());

export interface WhereClause {
	connector?: "AND" | "OR" | undefined;
	field: string;
	mode?: "sensitive" | "insensitive" | undefined;
	operator?: string | undefined;
	value: unknown;
}

const OAUTH_TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;
const SESSION_HANDLE_PREFIX = "rsh1.";
const SESSION_HANDLE_RE = /^rsh1\.([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/;
const HANDLE_INFO = "ryu-session-handle-v1";
/** Tokens one request may present; a browser holds at most a few sessions. */
const REQUEST_MEMO_MAX_ENTRIES = 64;

function asRecord(value: unknown): AuthRecord | null {
	const parsed = recordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function handleKeyFrom(secret: string | undefined): Buffer {
	// A process without a configured secret still gets unforgeable handles;
	// they are only valid inside this process, which is acceptable for tests and
	// single-process development servers.
	const ikm = secret ? Buffer.from(secret, "utf8") : randomBytes(32);
	return Buffer.from(hkdfSync("sha256", ikm, HANDLE_INFO, HANDLE_INFO, 32));
}

export interface SessionTokenCodec {
	/** Stored values a presented token or handle may match. */
	candidates(presented: string): string[];
	/** Opaque handle for a stored digest. */
	handleFor(digest: string): string;
	/**
	 * Token to return for a stored row: the token this request presented for
	 * it, else a handle (or the stored value of a legacy raw row).
	 */
	presentable(stored: string): string;
	/**
	 * Remember a token the current request presented, so its row reads back
	 * unchanged for the rest of that request and for nobody else.
	 */
	remember(presented: string): void;
}

export function createSessionTokenCodec(
	secret: string | undefined,
	requestScope: () => AuthRequestScope | undefined = currentAuthRequestScope
): SessionTokenCodec {
	const key = handleKeyFrom(secret);
	// Digest to presented token, per request scope. The entry goes away with
	// the scope object, and two auth instances never share a codec.
	const presentedByRequest = new WeakMap<
		AuthRequestScope,
		Map<string, string>
	>();

	function presentedInRequest(create: boolean): Map<string, string> | null {
		const scope = requestScope();
		if (!scope) {
			return null;
		}
		const existing = presentedByRequest.get(scope);
		if (existing || !create) {
			return existing ?? null;
		}
		const created = new Map<string, string>();
		presentedByRequest.set(scope, created);
		return created;
	}

	function mac(hex: string): string {
		return createHmac("sha256", key).update(hex).digest("base64url");
	}

	function digestFromHandle(value: string): string | null {
		const match = SESSION_HANDLE_RE.exec(value);
		if (!(match?.[1] && match[2])) {
			return null;
		}
		const expected = Buffer.from(mac(match[1]), "utf8");
		const actual = Buffer.from(match[2], "utf8");
		if (
			expected.length !== actual.length ||
			!timingSafeEqual(expected, actual)
		) {
			return null;
		}
		return `sha256:${match[1]}`;
	}

	return {
		candidates(presented) {
			const fromHandle = digestFromHandle(presented);
			return fromHandle ? [fromHandle] : tokenLookupCandidates(presented);
		},
		handleFor(digest) {
			const hex = digest.slice("sha256:".length);
			return `${SESSION_HANDLE_PREFIX}${hex}.${mac(hex)}`;
		},
		presentable(stored) {
			if (!isTokenDigest(stored)) {
				// Legacy raw row (until the boot migration digests it).
				return stored;
			}
			return presentedInRequest(false)?.get(stored) ?? this.handleFor(stored);
		},
		remember(presented) {
			if (digestFromHandle(presented)) {
				return;
			}
			const memo = presentedInRequest(true);
			if (!memo) {
				return;
			}
			const digest = digestToken(presented);
			if (memo.has(digest) || memo.size < REQUEST_MEMO_MAX_ENTRIES) {
				memo.set(digest, presented);
			}
		},
	};
}

/** Field of each model whose value is stored as a lookup digest. */
const DIGESTED_FIELDS: Record<string, string> = {
	deviceCode: "deviceCode",
	session: "token",
};

function stringValues(value: unknown): string[] | null {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
		return value;
	}
	return null;
}

export class AuthTokenAtRest {
	readonly sessions: SessionTokenCodec;

	constructor(secret: string | undefined) {
		this.sessions = createSessionTokenCodec(secret);
	}

	private candidatesFor(model: string, presented: string): string[] {
		return model === "session"
			? this.sessions.candidates(presented)
			: tokenLookupCandidates(presented);
	}

	/** Rewrite `where` clauses on digested fields to match stored digests. */
	where<W extends WhereClause>(model: string, where: W[] | undefined): W[] {
		const field = DIGESTED_FIELDS[model];
		if (!(field && where)) {
			return where ?? [];
		}
		return where.map((clause) => {
			if (clause.field !== field) {
				return clause;
			}
			const operator = clause.operator ?? "eq";
			const values = stringValues(clause.value);
			if (!values || (operator !== "eq" && operator !== "in")) {
				return clause;
			}
			if (model === "session") {
				for (const value of values) {
					this.sessions.remember(value);
				}
			}
			const candidates = values.flatMap((value) =>
				this.candidatesFor(model, value)
			);
			return { ...clause, operator: "in", value: candidates };
		});
	}

	/** Seal or digest the credential fields of a create/update payload. */
	write<T>(model: string, data: T): T {
		const record = asRecord(data);
		if (!record) {
			return data;
		}
		if (model === "account") {
			const output = { ...record };
			for (const field of OAUTH_TOKEN_FIELDS) {
				const value = output[field];
				if (typeof value === "string" && value && !isSealed(value)) {
					output[field] = seal(value);
				}
			}
			// SAFETY: only known string token fields changed type-preservingly.
			return output as T;
		}
		const field = DIGESTED_FIELDS[model];
		const value = field ? record[field] : undefined;
		if (field && typeof value === "string" && !isTokenDigest(value)) {
			if (model === "session") {
				this.sessions.remember(value);
			}
			// SAFETY: a string field is replaced by another string.
			return { ...record, [field]: digestToken(value) } as T;
		}
		return data;
	}

	/**
	 * Open sealed OAuth tokens and replace stored session digests with the
	 * token the caller can use. Also applied to joined `account`/`session`
	 * relations (e.g. a user found with `join: { account: true }`).
	 */
	read<T>(model: string, value: T, presentedTokens?: string[]): T {
		const record = asRecord(value);
		if (!record) {
			return value;
		}
		let output: AuthRecord = record;
		if (model === "account") {
			output = this.openAccount(record);
		} else if (model === "session") {
			output = this.presentSession(record, presentedTokens);
		}
		for (const [joinKey, joinModel] of [
			["account", "account"],
			["accounts", "account"],
			["session", "session"],
			["sessions", "session"],
		] as const) {
			if (joinKey === model || !(joinKey in output)) {
				continue;
			}
			const joined = output[joinKey];
			const mapped = Array.isArray(joined)
				? joined.map((item) => this.read(joinModel, item))
				: this.read(joinModel, joined);
			if (mapped !== joined) {
				output = { ...output, [joinKey]: mapped };
			}
		}
		// SAFETY: only credential string fields were replaced with strings.
		return output as T;
	}

	private openAccount(record: AuthRecord): AuthRecord {
		const output = { ...record };
		for (const field of OAUTH_TOKEN_FIELDS) {
			const stored = output[field];
			if (typeof stored === "string" && isSealed(stored)) {
				output[field] = open(stored);
			}
		}
		return output;
	}

	private presentSession(
		record: AuthRecord,
		presentedTokens: string[] | undefined
	): AuthRecord {
		const stored = record.token;
		if (typeof stored !== "string") {
			return record;
		}
		const presented = presentedTokens?.find((token) =>
			this.sessions.candidates(token).includes(stored)
		);
		const token = presented ?? this.sessions.presentable(stored);
		return token === stored ? record : { ...record, token };
	}

	/** Raw tokens a `where` presented for the model's digested field. */
	presentedTokens(
		model: string,
		where: WhereClause[] | undefined
	): string[] | undefined {
		const field = DIGESTED_FIELDS[model];
		if (!(field && where)) {
			return;
		}
		return where
			.filter((clause) => clause.field === field)
			.flatMap((clause) => stringValues(clause.value) ?? []);
	}
}
