import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	openSessionPii,
	sealSessionCreate,
	stripSessionPiiUpdate,
} from "./session-pii-at-rest.ts";

const IP = "203.0.113.77";
const UA = "Marker-Agent/9.9";
// The helpers are generic over the row shape; tests pass partial rows, so they
// widen it to a record to compare results against a subset of the input.
type Row = Record<string, unknown>;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
	saved = { ...process.env };
	process.env.RYU_DB_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
	process.env.RYU_DB_CONTENT_SEAL = "1";
});

afterEach(() => {
	process.env = saved;
});

describe("session IP and user agent at rest", () => {
	it("assigns an id, seals both fields and opens them on read", () => {
		const { data, forceAllowId } = sealSessionCreate({
			userId: "user_1",
			token: "t",
			ipAddress: IP,
			userAgent: UA,
		});
		expect(forceAllowId).toBe(true);
		const row = data as Record<string, string>;
		expect(row.id).toMatch(/^[0-9a-f]{24}$/);
		expect(JSON.stringify(row)).not.toContain(IP);
		expect(JSON.stringify(row)).not.toContain(UA);
		expect(row.ipAddress?.startsWith("encm:v1:")).toBe(true);
		const opened = openSessionPii(row);
		expect(opened.ipAddress).toBe(IP);
		expect(opened.userAgent).toBe(UA);
		// Bound to the session id and keyed per user: elsewhere it does not open (reads as null).
		expect(
			openSessionPii<Row>({ ...row, id: "f".repeat(24) }).ipAddress
		).toBeNull();
		expect(
			openSessionPii<Row>({ ...row, userId: "user_2" }).userAgent
		).toBeNull();
	});

	it("writes plaintext in rollout step 1 and reads legacy rows", () => {
		process.env.RYU_DB_CONTENT_SEAL = undefined;
		const input = { userId: "user_1", ipAddress: IP, userAgent: UA };
		const { data, forceAllowId } = sealSessionCreate(input);
		expect(forceAllowId).toBe(false);
		expect(data).toEqual(input);
		const legacy = { id: "a".repeat(24), ...input };
		expect(openSessionPii(legacy)).toEqual(legacy);
	});

	it("seals or escapes envelope lookalikes in step 1 and reads them back", () => {
		process.env.RYU_DB_CONTENT_SEAL = undefined;
		for (const userAgent of ["encm:v1:x", "enc:v1:x", "encp:v1:x"]) {
			const { data, forceAllowId } = sealSessionCreate({
				userId: "user_1",
				ipAddress: IP,
				userAgent,
			});
			expect(forceAllowId).toBe(true);
			const row = data as Record<string, string>;
			expect(row.userAgent?.startsWith("encm:v1:")).toBe(true);
			expect(row.ipAddress).toBe(IP);
			expect(openSessionPii(row).userAgent).toBe(userAgent);
		}
		process.env.RYU_DB_MASTER_KEY = undefined;
		process.env.RYU_DB_ALLOW_PLAINTEXT_SECRETS = "1";
		const { data } = sealSessionCreate({ userId: "u", userAgent: "encm:v1:x" });
		const row = data as Record<string, string>;
		expect(row.userAgent).toBe("encp:v1:encm:v1:x");
		expect(openSessionPii(row).userAgent).toBe("encm:v1:x");
	});

	it("reads a legacy lookalike or foreign seal as null instead of failing", () => {
		process.env.RYU_DB_CONTENT_SEAL = undefined;
		const legacy = {
			id: "a".repeat(24),
			userId: "user_1",
			ipAddress: IP,
			userAgent: "encm:v1:x",
		};
		const opened = openSessionPii(legacy);
		expect(opened.userAgent).toBeNull();
		expect(opened.ipAddress).toBe(IP);
	});

	it("drops lookalike PII from step-1 updates only", () => {
		process.env.RYU_DB_CONTENT_SEAL = undefined;
		expect(
			stripSessionPiiUpdate<Row>({
				expiresAt: 1,
				ipAddress: IP,
				userAgent: "enc:v1:x",
			})
		).toEqual({ expiresAt: 1, ipAddress: IP });
		expect(stripSessionPiiUpdate({ ipAddress: IP })).toEqual({ ipAddress: IP });
	});

	it("keeps unbound PII out of sealing-era updates", () => {
		expect(
			stripSessionPiiUpdate<Row>({ expiresAt: 1, ipAddress: IP, userAgent: UA })
		).toEqual({ expiresAt: 1 });
	});
});
