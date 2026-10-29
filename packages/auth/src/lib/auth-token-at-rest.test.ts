import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { digestToken, isSealed } from "@ryu/db/crypto";
import { AuthTokenAtRest, type WhereClause } from "./auth-token-at-rest.ts";
import {
	type BetterAuthAdapter,
	wrapSsoProviderAdapter,
} from "./sso-provider-encryption.ts";

const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
const ORIGINAL_KEY = process.env.RYU_DB_MASTER_KEY;
const ORIGINAL_OVERRIDE = process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;

type Row = Record<string, unknown>;

function matches(row: Row, where: WhereClause[] | undefined): boolean {
	return (where ?? []).every((clause) => {
		const value = row[clause.field];
		if (clause.operator === "in") {
			return Array.isArray(clause.value) && clause.value.includes(value);
		}
		return value === clause.value;
	});
}

/**
 * The fake stores untyped rows; Better Auth's adapter methods are generic in
 * the row type their caller expects.
 */
function rowAs<T>(value: unknown): T {
	// SAFETY: test fake. Rows come back exactly as the caller stored them.
	return value as T;
}

/** A tiny in-memory Better Auth adapter: enough to watch what reaches disk. */
function memoryAdapter() {
	const tables = new Map<string, Row[]>();
	const table = (model: string) => {
		const rows = tables.get(model) ?? [];
		tables.set(model, rows);
		return rows;
	};
	let nextId = 0;
	const adapter: BetterAuthAdapter = {
		id: "memory",
		create: <T, R>({ model, data }: { data: Omit<T, "id">; model: string }) => {
			nextId += 1;
			const row: Row = { id: `row-${nextId}`, ...data };
			table(model).push(row);
			return Promise.resolve(rowAs<R>(structuredClone(row)));
		},
		findOne: <T>({ model, where }: { model: string; where: WhereClause[] }) => {
			const row = table(model).find((r) => matches(r, where));
			return Promise.resolve(row ? rowAs<T>(structuredClone(row)) : null);
		},
		findMany: <T>({ model, where }: { model: string; where?: WhereClause[] }) =>
			Promise.resolve(
				table(model)
					.filter((r) => matches(r, where))
					.map((r) => rowAs<T>(structuredClone(r)))
			),
		count: ({ model, where }) =>
			Promise.resolve(table(model).filter((r) => matches(r, where)).length),
		update: <T>({
			model,
			where,
			update,
		}: {
			model: string;
			update: Record<string, unknown>;
			where: WhereClause[];
		}) => {
			const row = table(model).find((r) => matches(r, where));
			if (!row) {
				return Promise.resolve(null);
			}
			Object.assign(row, update);
			return Promise.resolve(rowAs<T>(structuredClone(row)));
		},
		updateMany: ({ model, where, update }) => {
			const rows = table(model).filter((r) => matches(r, where));
			for (const row of rows) {
				Object.assign(row, update);
			}
			return Promise.resolve(rows.length);
		},
		delete: ({ model, where }) => {
			const rows = table(model);
			const index = rows.findIndex((r) => matches(r, where));
			if (index >= 0) {
				rows.splice(index, 1);
			}
			return Promise.resolve();
		},
		deleteMany: ({ model, where }) => {
			const rows = table(model);
			const keep = rows.filter((r) => !matches(r, where));
			const removed = rows.length - keep.length;
			tables.set(model, keep);
			return Promise.resolve(removed);
		},
		consumeOne: <T>({
			model,
			where,
		}: {
			model: string;
			where: WhereClause[];
		}) => {
			const rows = table(model);
			const index = rows.findIndex((r) => matches(r, where));
			if (index < 0) {
				return Promise.resolve(null);
			}
			const [row] = rows.splice(index, 1);
			return Promise.resolve(row ? rowAs<T>(structuredClone(row)) : null);
		},
		incrementOne: () => Promise.resolve(null),
		transaction: (callback) => callback(adapter),
	};
	return { adapter, tables, disk: () => JSON.stringify([...tables]) };
}

function setup() {
	const memory = memoryAdapter();
	const wrapped = wrapSsoProviderAdapter(
		memory.adapter,
		new AuthTokenAtRest("test-better-auth-secret")
	);
	return { ...memory, wrapped };
}

function tokenOf(row: unknown): string {
	if (row && typeof row === "object" && "token" in row) {
		return String(row.token);
	}
	throw new Error("row has no token");
}

describe("Better Auth credentials at rest", () => {
	beforeEach(() => {
		process.env.RYU_DB_MASTER_KEY = TEST_KEY;
		delete process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
	});
	afterEach(() => {
		if (ORIGINAL_KEY === undefined) {
			delete process.env.RYU_DB_MASTER_KEY;
		} else {
			process.env.RYU_DB_MASTER_KEY = ORIGINAL_KEY;
		}
		if (ORIGINAL_OVERRIDE === undefined) {
			delete process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS;
		} else {
			process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS = ORIGINAL_OVERRIDE;
		}
	});

	it("stores only a session token digest and still finds the session by token", async () => {
		const { wrapped, tables, disk } = setup();
		const raw = "RawSessionToken0123456789abcdefXY";
		const created = await wrapped.create({
			model: "session",
			data: { token: raw, userId: "u1" },
		});
		expect(tokenOf(created)).toBe(raw);
		expect(tables.get("session")?.[0]?.token).toBe(digestToken(raw));
		expect(disk()).not.toContain(raw);

		const found = await wrapped.findOne({
			model: "session",
			where: [{ field: "token", value: raw }],
		});
		expect(tokenOf(found)).toBe(raw);

		const updated = await wrapped.update({
			model: "session",
			where: [{ field: "token", value: raw }],
			update: { activeOrganizationId: "org-1" },
		});
		expect(tokenOf(updated)).toBe(raw);
		expect(disk()).not.toContain(raw);
	});

	it("refuses a stolen digest as a credential", async () => {
		const { wrapped, tables } = setup();
		await wrapped.create({
			model: "session",
			data: { token: "AnotherRawSessionToken0123456789", userId: "u1" },
		});
		const stolen = String(tables.get("session")?.[0]?.token);
		expect(
			await wrapped.findOne({
				model: "session",
				where: [{ field: "token", value: stolen }],
			})
		).toBeNull();
	});

	it("reads legacy plaintext session rows and lists others by an unforgeable handle", async () => {
		const { adapter, wrapped } = setup();
		const legacy = "LegacyPlaintextSessionToken01234";
		await adapter.create({
			model: "session",
			data: { token: legacy, userId: "u1" },
		});
		const found = await wrapped.findOne({
			model: "session",
			where: [{ field: "token", value: legacy }],
		});
		expect(tokenOf(found)).toBe(legacy);

		// A session nobody presented in this process lists as a handle.
		const atRest = new AuthTokenAtRest("test-better-auth-secret");
		const other = wrapSsoProviderAdapter(adapter, atRest);
		await adapter.create({
			model: "session",
			data: { token: digestToken("OtherDeviceToken"), userId: "u1" },
		});
		const listed = await other.findMany({
			model: "session",
			where: [{ field: "userId", value: "u1" }],
		});
		const handle = listed.map(tokenOf).find((t) => t.startsWith("rsh1."));
		expect(handle).toBeDefined();
		const byHandle = await other.findOne({
			model: "session",
			where: [{ field: "token", value: String(handle) }],
		});
		expect(byHandle).not.toBeNull();

		// A forged handle (right digest, wrong MAC) matches nothing.
		const forged = `${String(handle).slice(0, -2)}AA`;
		expect(
			await other.findOne({
				model: "session",
				where: [{ field: "token", value: forged }],
			})
		).toBeNull();

		await other.delete({
			model: "session",
			where: [{ field: "token", value: String(handle) }],
		});
		expect(
			await other.count({
				model: "session",
				where: [{ field: "userId", value: "u1" }],
			})
		).toBe(1);
	});

	it("lists the caller's own session with the token it presented", async () => {
		const { wrapped } = setup();
		const current = "CurrentSessionToken0123456789abc";
		await wrapped.create({
			model: "session",
			data: { token: current, userId: "u2" },
		});
		await wrapped.findOne({
			model: "session",
			where: [{ field: "token", value: current }],
		});
		const listed = await wrapped.findMany({
			model: "session",
			where: [{ field: "userId", value: "u2" }],
		});
		expect(listed.map(tokenOf)).toEqual([current]);
	});

	it("seals OAuth account tokens and opens them, including legacy plaintext", async () => {
		const { adapter, wrapped, tables, disk } = setup();
		const created = await wrapped.create({
			model: "account",
			data: {
				accessToken: "gho_ACCESS_SECRET",
				idToken: "eyJ.ID_SECRET",
				password: null,
				providerId: "github",
				refreshToken: "ghr_REFRESH_SECRET",
				userId: "u1",
			},
		});
		const stored = tables.get("account")?.[0];
		expect(isSealed(String(stored?.accessToken))).toBe(true);
		expect(isSealed(String(stored?.refreshToken))).toBe(true);
		expect(isSealed(String(stored?.idToken))).toBe(true);
		expect(stored?.password).toBeNull();
		expect(disk()).not.toContain("ACCESS_SECRET");
		expect(disk()).not.toContain("REFRESH_SECRET");
		expect(disk()).not.toContain("ID_SECRET");
		expect(created).toMatchObject({ accessToken: "gho_ACCESS_SECRET" });

		await wrapped.update({
			model: "account",
			where: [{ field: "userId", value: "u1" }],
			update: { accessToken: "gho_ROTATED_SECRET" },
		});
		expect(disk()).not.toContain("ROTATED_SECRET");
		const found = await wrapped.findOne({
			model: "account",
			where: [{ field: "userId", value: "u1" }],
		});
		expect(found).toMatchObject({
			accessToken: "gho_ROTATED_SECRET",
			refreshToken: "ghr_REFRESH_SECRET",
		});

		await adapter.create({
			model: "account",
			data: { accessToken: "legacy-plain", userId: "u3" },
		});
		const joined = await wrapped.findOne({
			model: "account",
			where: [{ field: "userId", value: "u3" }],
		});
		expect(joined).toMatchObject({ accessToken: "legacy-plain" });

		// A user read with its accounts joined gets them opened too.
		await adapter.create({
			model: "user",
			data: { account: [stored], email: "a@example.com" },
		});
		const user = await wrapped.findOne({
			model: "user",
			where: [{ field: "email", value: "a@example.com" }],
		});
		expect(JSON.stringify(user)).toContain("gho_ROTATED_SECRET");
	});

	it("fails closed instead of storing an OAuth token in plaintext", async () => {
		delete process.env.RYU_DB_MASTER_KEY;
		const { wrapped, disk } = setup();
		await expect(
			wrapped.create({
				model: "account",
				data: { accessToken: "gho_NO_KEY_SECRET", userId: "u1" },
			})
		).rejects.toThrow(/RYU_DB_MASTER_KEY/);
		expect(disk()).not.toContain("NO_KEY_SECRET");
	});

	it("stores device codes as digests and redeems by the raw code", async () => {
		const { wrapped, disk } = setup();
		const deviceCode = "DEVICE-CODE-SECRET-0123456789abcdef";
		await wrapped.create({
			model: "deviceCode",
			data: { deviceCode, status: "pending", userCode: "ABCD1234" },
		});
		expect(disk()).not.toContain(deviceCode);
		const found = await wrapped.findOne({
			model: "deviceCode",
			where: [{ field: "deviceCode", value: deviceCode }],
		});
		expect(found).toMatchObject({ status: "pending" });
		const byUserCode = await wrapped.findOne({
			model: "deviceCode",
			where: [{ field: "userCode", value: "ABCD1234" }],
		});
		expect(byUserCode).not.toBeNull();
	});
});
