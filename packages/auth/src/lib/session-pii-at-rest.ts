import { randomBytes } from "node:crypto";
import {
	contentSealingEnabled,
	looksLikeEnvelope,
	openAnyNullable,
	writeBound,
} from "@ryu/db/crypto";

/**
 * Session IP address and user agent at rest (`docs/encryption-at-rest.md`, cloud PII).
 *
 * Both are display-only PII, so the Better Auth adapter wrapper seals them per user
 * (`encm:v1:`, collection `session`, tenant = `userId`, bound to the session id) once
 * `RYU_DB_CONTENT_SEAL=1`, and opens them on every read. A sealed value has to be bound to the
 * id before the insert, so a sealing create pre-assigns an ObjectId-shaped id (the Mongo
 * adapter turns the hex string into an ObjectId). Legacy plaintext rows read as is.
 *
 * In rollout step 1 a value that starts like an envelope (a User-Agent of `encm:v1:x`) still goes
 * through `writeBound`, which seals or escapes it, so stored plaintext never looks sealed. A field
 * that does not open (a legacy row with such a value) reads as null instead of failing the
 * session lookup.
 */

const SESSION_COLLECTION = "session";
const PII_FIELDS = ["ipAddress", "userAgent"] as const;

type AuthRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AuthRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A new ObjectId hex: 4 bytes of seconds, then 8 random bytes. */
export function newObjectIdHex(): string {
	const seconds = Buffer.alloc(4);
	seconds.writeUInt32BE(Math.floor(Date.now() / 1000));
	return Buffer.concat([seconds, randomBytes(8)]).toString("hex");
}

function hasLookalikePii(data: AuthRecord): boolean {
	return PII_FIELDS.some((field) => {
		const value = data[field];
		return typeof value === "string" && looksLikeEnvelope(value);
	});
}

/**
 * The create payload for a session row: with content sealing on (or, in step 1, when a PII value
 * starts like an envelope), an id is assigned when missing and the PII fields go through
 * `writeBound` under it. Returns `forceAllowId: true` whenever the values were bound to an id, so
 * the adapter keeps that id.
 */
export function sealSessionCreate<T>(data: T): {
	readonly data: T;
	readonly forceAllowId: boolean;
} {
	if (!isRecord(data)) {
		return { data, forceAllowId: false };
	}
	if (!(contentSealingEnabled() || hasLookalikePii(data))) {
		return { data, forceAllowId: false };
	}
	const userId = typeof data.userId === "string" ? data.userId : null;
	if (userId === null) {
		return { data: withoutLookalikePii(data), forceAllowId: false };
	}
	const id = typeof data.id === "string" ? data.id : newObjectIdHex();
	const output: AuthRecord = { ...data, id };
	for (const field of PII_FIELDS) {
		const value = output[field];
		if (typeof value === "string") {
			output[field] = writeBound(SESSION_COLLECTION, field, userId, id, value);
		}
	}
	// SAFETY: only `id` and the two PII strings changed, with values of the same types.
	// The values are bound to this id, so the adapter must keep it.
	return { data: output as T, forceAllowId: true };
}

/** A row without the PII values that cannot be stored safely (unbound lookalikes). */
function withoutLookalikePii<T extends AuthRecord>(data: T): T {
	const output: AuthRecord = { ...data };
	for (const field of PII_FIELDS) {
		const value = output[field];
		if (typeof value === "string" && looksLikeEnvelope(value)) {
			output[field] = null;
		}
	}
	// SAFETY: only optional display strings were cleared.
	return output as T;
}

/** One PII field opened, or null when it does not open (display-only, never fails a lookup). */
export function openSessionPiiField(
	field: (typeof PII_FIELDS)[number],
	userId: string,
	id: string,
	stored: string | null | undefined
): string | null {
	try {
		return openAnyNullable(SESSION_COLLECTION, field, userId, id, stored);
	} catch {
		return null;
	}
}

/** A session row with its IP address and user agent opened (legacy plaintext as is). */
export function openSessionPii<T>(value: T): T {
	if (!isRecord(value)) {
		return value;
	}
	const id = typeof value.id === "string" ? value.id : null;
	const userId = typeof value.userId === "string" ? value.userId : null;
	if (id === null || userId === null) {
		return value;
	}
	let output: AuthRecord | null = null;
	for (const field of PII_FIELDS) {
		const stored = value[field];
		if (typeof stored === "string") {
			output ??= { ...value };
			output[field] = openSessionPiiField(field, userId, id, stored);
		}
	}
	// SAFETY: only the two PII strings were replaced by their opened values.
	return (output ?? value) as T;
}

/**
 * An update payload for a session row: the PII fields cannot be bound without the row id and
 * user, which an update does not carry, so a sealing build drops them from updates (Better Auth
 * sets them only at create).
 */
export function stripSessionPiiUpdate<T>(update: T): T {
	if (!isRecord(update)) {
		return update;
	}
	// Step 1 keeps plaintext updates, except a value that would be stored looking sealed.
	if (!(contentSealingEnabled() || hasLookalikePii(update))) {
		return update;
	}
	if (!PII_FIELDS.some((field) => field in update)) {
		return update;
	}
	const piiFields: readonly string[] = PII_FIELDS;
	const sealing = contentSealingEnabled();
	const output: AuthRecord = Object.fromEntries(
		Object.entries(update).filter(
			([field, value]) =>
				!(
					piiFields.includes(field) &&
					(sealing || (typeof value === "string" && looksLikeEnvelope(value)))
				)
		)
	);
	// SAFETY: only optional display fields were removed.
	return output as T;
}
