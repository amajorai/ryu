import { open, seal } from "@ryu/db/crypto";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { z } from "zod";
import { AuthTokenAtRest } from "./auth-token-at-rest.ts";
import {
	openSessionPii,
	sealSessionCreate,
	stripSessionPiiUpdate,
} from "./session-pii-at-rest.ts";

type BetterAuthAdapterFactory = ReturnType<typeof mongodbAdapter>;
export type BetterAuthAdapter = ReturnType<BetterAuthAdapterFactory>;
type BetterAuthTransactionAdapter = Omit<BetterAuthAdapter, "transaction">;
type AdapterWriteData = Parameters<BetterAuthAdapter["update"]>[0]["update"];
type AdapterCreateInput<T> = Omit<
	Parameters<BetterAuthAdapter["create"]>[0],
	"data"
> & { data: Omit<T, "id"> };
/** A BSON ObjectId from any `bson` copy (never a secret; passed through). */
interface ObjectIdLike {
	toHexString(): string;
}
type SsoValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| Date
	| ObjectIdLike
	| SsoValue[]
	| { [key: string]: SsoValue };
const objectIdSchema = z.custom<ObjectIdLike>(
	(value) =>
		typeof value === "object" &&
		value !== null &&
		"toHexString" in value &&
		typeof value.toHexString === "function"
);
// A provider row written outside Better Auth (an import or a manual repair)
// can hold an ObjectId in a plain string field such as `organizationId`; the
// Mongo adapter returns it unchanged. Accept it so such a row still reads.
const ssoValueSchema: z.ZodType<SsoValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.undefined(),
		z.date(),
		objectIdSchema,
		z.array(ssoValueSchema),
		z.record(z.string(), ssoValueSchema),
	])
);
const ssoRecordSchema = z.record(z.string(), ssoValueSchema);
type SsoRecord = z.infer<typeof ssoRecordSchema>;
const objectBoundarySchema = z.object({}).loose();

const SENSITIVE_OIDC_FIELDS = ["clientSecret"] as const;
const SENSITIVE_SAML_FIELDS = [
	"cert",
	"decryptionPvk",
	"idpMetadata",
	"privateKey",
	"spMetadata",
] as const;

const NESTED_SAML_SECRET_FIELDS = [
	"metadata",
	"cert",
	"privateKey",
	"privateKeyPass",
	"encPrivateKey",
	"encPrivateKeyPass",
] as const;

function recordValue<T>(value: T): SsoRecord | null {
	return objectBoundarySchema.safeParse(value).success
		? ssoRecordSchema.parse(value)
		: null;
}

function transformSensitiveField(
	field: string,
	value: SsoValue,
	transform: (value: string) => string
): SsoValue {
	const stringValue = z.string().safeParse(value);
	if (stringValue.success) {
		return transform(stringValue.data);
	}
	if (field !== "idpMetadata" && field !== "spMetadata") {
		return value;
	}
	const record = recordValue(value);
	if (!record) {
		return value;
	}
	const output = { ...record };
	for (const key of NESTED_SAML_SECRET_FIELDS) {
		const secret = z.string().safeParse(output[key]);
		if (secret.success) {
			output[key] = transform(secret.data);
		}
	}
	return output;
}

function transformJsonField(
	value: SsoValue,
	fields: readonly string[],
	transform: (value: string) => string
): SsoValue {
	const serialized = z.string().safeParse(value);
	if (serialized.success) {
		let parsed: z.output<ReturnType<typeof z.json>>;
		try {
			parsed = z.json().parse(JSON.parse(serialized.data));
		} catch {
			return value;
		}
		// Parsing legacy/non-JSON values is permissive. Once parsing succeeds, every
		// cryptographic failure must propagate so plaintext can never reach a write.
		const transformed = transformJsonField(parsed, fields, transform);
		return JSON.stringify(transformed);
	}
	const record = recordValue(value);
	if (!record) {
		return value;
	}
	const output = { ...record };
	for (const field of fields) {
		const fieldValue = output[field];
		output[field] = transformSensitiveField(field, fieldValue, transform);
	}
	return output;
}

function transformSsoProviderRecord<T>(
	value: T,
	transform: (value: string) => string
): T {
	const record = recordValue(value);
	if (!record) {
		return value;
	}
	const output = { ...record };
	output.oidcConfig = transformJsonField(
		output.oidcConfig,
		SENSITIVE_OIDC_FIELDS,
		transform
	);
	output.samlConfig = transformJsonField(
		output.samlConfig,
		SENSITIVE_SAML_FIELDS,
		transform
	);
	const domainToken = z.string().safeParse(output.domainVerificationToken);
	if (domainToken.success) {
		output.domainVerificationToken = transform(domainToken.data);
	}
	// SAFETY: the provider record was parsed as JSON/date fields. Only known
	// secret strings change; JSON configs keep their string/object representation,
	// and all remaining fields retain the adapter's original model contract.
	return output as T;
}

function transformSsoPayload<T>(
	model: string,
	value: T,
	transform: (value: string) => string
): T {
	return model === "ssoProvider"
		? transformSsoProviderRecord(value, transform)
		: value;
}

export function sealSsoProviderRecord<T>(value: T): T {
	return transformSsoProviderRecord(value, seal);
}

export function openSsoProviderRecord<T>(value: T): T {
	return transformSsoProviderRecord(value, open);
}

function transformRead<T>(
	atRest: AuthTokenAtRest,
	model: string,
	value: T,
	presentedTokens?: string[]
): T {
	const read = atRest.read(
		model,
		transformSsoPayload(model, value, open),
		presentedTokens
	);
	return model === "session" ? openSessionPii(read) : read;
}

function transformWrite<T>(
	atRest: AuthTokenAtRest,
	model: string,
	value: T
): T {
	const written = atRest.write(model, transformSsoPayload(model, value, seal));
	return model === "session" ? stripSessionPiiUpdate(written) : written;
}

function defaultAtRest(): AuthTokenAtRest {
	return new AuthTokenAtRest(
		process.env.BETTER_AUTH_SECRET?.trim() || undefined
	);
}

/**
 * Add field encryption at the Better Auth adapter boundary. The adapter factory
 * has already serialized JSON fields when this wrapper sees writes and has
 * parsed them again when it sees reads, so secrets remain queryable only by
 * their non-sensitive provider metadata.
 *
 * Besides SSO provider secrets this seals OAuth account tokens and stores
 * session tokens and device codes as lookup digests (`auth-token-at-rest.ts`).
 */
export function wrapSsoProviderAdapter<
	T extends BetterAuthAdapter | BetterAuthTransactionAdapter,
>(adapter: T, atRest: AuthTokenAtRest = defaultAtRest()): T {
	const wrapped = { ...adapter };
	const originalCreate = adapter.create;
	wrapped.create = async <V extends AdapterWriteData, R = V>(
		input: AdapterCreateInput<V>
	) => {
		const presented = atRest.presentedTokens(input.model, [
			...Object.entries(input.data).map(([field, value]) => ({
				field,
				value,
			})),
		]);
		const sealed =
			input.model === "session"
				? sealSessionCreate(input.data)
				: { data: input.data, forceAllowId: false };
		const result = await originalCreate<V, R>({
			...input,
			...(sealed.forceAllowId ? { forceAllowId: true } : {}),
			data: atRest.write(
				input.model,
				transformSsoPayload(input.model, sealed.data, seal)
			),
		});
		return transformRead(atRest, input.model, result, presented);
	};
	const originalFindOne = adapter.findOne;
	wrapped.findOne = async <V>(
		input: Parameters<BetterAuthAdapter["findOne"]>[0]
	) => {
		const presented = atRest.presentedTokens(input.model, input.where);
		const result = await originalFindOne<V>({
			...input,
			where: atRest.where(input.model, input.where),
		});
		return transformRead(atRest, input.model, result, presented);
	};
	const originalFindMany = adapter.findMany;
	wrapped.findMany = async <V>(
		input: Parameters<BetterAuthAdapter["findMany"]>[0]
	) => {
		const presented = atRest.presentedTokens(input.model, input.where);
		const result = await originalFindMany<V>({
			...input,
			where: atRest.where(input.model, input.where),
		});
		return result.map((item) =>
			transformRead(atRest, input.model, item, presented)
		);
	};
	const originalCount = adapter.count;
	wrapped.count = async (input) =>
		originalCount({ ...input, where: atRest.where(input.model, input.where) });
	const originalUpdate = adapter.update;
	wrapped.update = async <V>(
		input: Parameters<BetterAuthAdapter["update"]>[0]
	) => {
		const presented = atRest.presentedTokens(input.model, input.where);
		const result = await originalUpdate<V>({
			...input,
			where: atRest.where(input.model, input.where),
			update: transformWrite(atRest, input.model, input.update),
		});
		return transformRead(atRest, input.model, result, presented);
	};
	const originalUpdateMany = adapter.updateMany;
	wrapped.updateMany = async (input) =>
		originalUpdateMany({
			...input,
			where: atRest.where(input.model, input.where),
			update: transformWrite(atRest, input.model, input.update),
		});
	const originalDelete = adapter.delete;
	wrapped.delete = async <V>(
		input: Parameters<BetterAuthAdapter["delete"]>[0]
	) =>
		originalDelete<V>({
			...input,
			where: atRest.where(input.model, input.where),
		});
	const originalDeleteMany = adapter.deleteMany;
	wrapped.deleteMany = async (input) =>
		originalDeleteMany({
			...input,
			where: atRest.where(input.model, input.where),
		});
	const originalConsumeOne = adapter.consumeOne;
	wrapped.consumeOne = async <V>(
		input: Parameters<BetterAuthAdapter["consumeOne"]>[0]
	) => {
		const presented = atRest.presentedTokens(input.model, input.where);
		const result = await originalConsumeOne<V>({
			...input,
			where: atRest.where(input.model, input.where),
		});
		return transformRead(atRest, input.model, result, presented);
	};
	const originalIncrementOne = adapter.incrementOne;
	wrapped.incrementOne = async <V>(
		input: Parameters<BetterAuthAdapter["incrementOne"]>[0]
	) => {
		const presented = atRest.presentedTokens(input.model, input.where);
		const result = await originalIncrementOne<V>({
			...input,
			where: atRest.where(input.model, input.where),
		});
		return transformRead(atRest, input.model, result, presented);
	};
	if ("transaction" in adapter && "transaction" in wrapped) {
		const originalTransaction = adapter.transaction;
		wrapped.transaction = async (callback) =>
			originalTransaction((transactionAdapter) =>
				callback(wrapSsoProviderAdapter(transactionAdapter, atRest))
			);
	}
	return wrapped;
}

export function encryptedMongoAdapter(
	database: Parameters<typeof mongodbAdapter>[0],
	config?: Parameters<typeof mongodbAdapter>[1]
): ReturnType<typeof mongodbAdapter> {
	const adapterFactory = mongodbAdapter(database, config);
	return (options) =>
		wrapSsoProviderAdapter(
			adapterFactory(options),
			new AuthTokenAtRest(
				options.secret?.trim() ||
					process.env.BETTER_AUTH_SECRET?.trim() ||
					undefined
			)
		);
}
