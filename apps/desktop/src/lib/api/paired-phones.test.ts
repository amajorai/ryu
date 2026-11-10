import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	approvePairedPhone,
	forgetPairedPhone,
	isForbidden,
	isRouteMissing,
	jwtSubject,
	listPairedPhones,
	MAX_MEMBER_USER_ID_BYTES,
	memberUserIdProblem,
	type PairedDevice,
	pairingCheckCode,
	renamePairedPhone,
	revokeMemberAppDelegations,
	revokePairedPhoneGrants,
	sortPairedPhones,
	userIdFromPrincipal,
} from "./paired-phones.ts";

interface Received {
	body: string;
	method: string;
	path: string;
}

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function device(overrides: Partial<PairedDevice>): PairedDevice {
	return {
		always_allowed: [],
		app: "ryu",
		check_code: null,
		device_id: "dev",
		foreground: false,
		label: "Phone",
		last_seen_ms: 0,
		paired_at_ms: 0,
		platform: "ios",
		state: "active",
		...overrides,
	};
}

function serve(handler: (request: Request) => Response) {
	const received: Received[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			received.push({
				body: await request.clone().text(),
				method: request.method,
				path: url.pathname,
			});
			return handler(request);
		},
	});
	servers.push(server);
	return { received, target: { token: "node", url: server.url.toString() } };
}

it("lists phones with pending pairings first and the most recent active next", async () => {
	const { received, target } = serve(() =>
		Response.json({
			principal_id: "owner:local",
			devices: [
				device({ device_id: "old", last_seen_ms: 1 }),
				device({ device_id: "new", last_seen_ms: 9 }),
				device({ device_id: "wait", state: "pending", last_seen_ms: 0 }),
			],
		})
	);
	const snapshot = await listPairedPhones(target);
	expect(snapshot.principal_id).toBe("owner:local");
	expect(snapshot.devices.map((entry) => entry.device_id)).toEqual([
		"wait",
		"new",
		"old",
	]);
	expect(received).toEqual([
		{ body: "", method: "GET", path: "/api/device-tools/devices" },
	]);
});

it("sends approve, rename, revoke and forget to the device's own path", async () => {
	const { received, target } = serve((request) => {
		if (request.method === "POST") {
			return Response.json({ device_id: "a/b", state: "active" });
		}
		if (request.method === "DELETE") {
			return Response.json({ forgotten: true });
		}
		return Response.json({ device_id: "a/b", always_allowed: [] });
	});
	expect(await approvePairedPhone(target, "a/b")).toEqual({
		device_id: "a/b",
		state: "active",
	});
	await renamePairedPhone(target, "a/b", "  Kitchen phone  ");
	await revokePairedPhoneGrants(target, "a/b", ["calendar.read"]);
	expect(await forgetPairedPhone(target, "a/b")).toEqual({ forgotten: true });
	expect(received).toEqual([
		{
			body: "",
			method: "POST",
			path: "/api/device-tools/devices/a%2Fb/approve-pair",
		},
		{
			body: '{"label":"Kitchen phone"}',
			method: "PATCH",
			path: "/api/device-tools/devices/a%2Fb",
		},
		{
			body: '{"revoke":["calendar.read"]}',
			method: "PATCH",
			path: "/api/device-tools/devices/a%2Fb",
		},
		{ body: "", method: "DELETE", path: "/api/device-tools/devices/a%2Fb" },
	]);
});

it("revokes one member's app delegations with a trimmed user id", async () => {
	const { received, target } = serve(() =>
		Response.json({ user_id: "u-1", revoked_before: 1_700_000_000 })
	);
	expect(await revokeMemberAppDelegations(target, "  u-1 ")).toEqual({
		user_id: "u-1",
		revoked_before: 1_700_000_000,
	});
	expect(received).toEqual([
		{
			body: '{"user_id":"u-1"}',
			method: "POST",
			path: "/api/app-delegations/revoke",
		},
	]);
});

it("classifies a missing route and a refusal so the UI can feature-detect", async () => {
	const missing = serve(() => new Response("not found", { status: 404 }));
	const missingError = await listPairedPhones(missing.target).catch(
		(error: unknown) => error
	);
	expect(isRouteMissing(missingError)).toBe(true);
	expect(isForbidden(missingError)).toBe(false);

	const refused = serve(() =>
		Response.json({ error: "device_not_paired" }, { status: 403 })
	);
	const refusedError = await approvePairedPhone(refused.target, "d").catch(
		(error: unknown) => error
	);
	expect(isForbidden(refusedError)).toBe(true);
	expect(isRouteMissing(refusedError)).toBe(false);
	expect(isRouteMissing(new Error("offline"))).toBe(false);
});

it("validates member ids like Core and reads the user from a principal", () => {
	expect(memberUserIdProblem("   ")).toBe("empty");
	expect(memberUserIdProblem("x".repeat(MAX_MEMBER_USER_ID_BYTES))).toBeNull();
	expect(memberUserIdProblem("x".repeat(MAX_MEMBER_USER_ID_BYTES + 1))).toBe(
		"too_long"
	);
	expect(memberUserIdProblem("é".repeat(129))).toBe("too_long");
	expect(userIdFromPrincipal("user:abc")).toBe("abc");
	expect(userIdFromPrincipal("user:")).toBeNull();
	expect(userIdFromPrincipal("owner:local")).toBeNull();
	expect(sortPairedPhones([])).toEqual([]);
});

it("reads a JWT subject for cache scoping and ignores anything else", () => {
	const encode = (value: object) =>
		btoa(JSON.stringify(value))
			.replaceAll("=", "")
			.replaceAll("+", "-")
			.replaceAll("/", "_");
	expect(jwtSubject(`${encode({})}.${encode({ sub: "user-42" })}.sig`)).toBe(
		"user-42"
	);
	expect(jwtSubject(`${encode({})}.${encode({ sub: "" })}.sig`)).toBeNull();
	expect(jwtSubject(`${encode({})}.${encode({ iss: "x" })}.sig`)).toBeNull();
	expect(jwtSubject("not-a-jwt")).toBeNull();
	expect(jwtSubject("a.%%%.c")).toBeNull();
	expect(jwtSubject(null)).toBeNull();
	expect(jwtSubject(undefined)).toBeNull();
});

/** The shared pairing-check-code derivation, written out to pin the golden vector. */
function referenceCheckCode(deviceId: string, spki: Uint8Array): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const digest = createHash("sha256")
		.update("ryu-device-check-v1\n")
		.update(deviceId.toLowerCase())
		.update("\n")
		.update(spki)
		.digest();
	const bits = [...digest]
		.map((byte) => byte.toString(2).padStart(8, "0"))
		.join("");
	let code = "";
	for (let index = 0; index < 6; index += 1) {
		code += alphabet[Number.parseInt(bits.slice(index * 5, index * 5 + 5), 2)];
	}
	return `${code.slice(0, 3)}-${code.slice(3)}`;
}

const GOLDEN_DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const GOLDEN_CHECK_CODE = "ZDX-MJ5";

it("matches the shared golden pairing check code vector", () => {
	expect(referenceCheckCode(GOLDEN_DEVICE_ID, new Uint8Array(91))).toBe(
		GOLDEN_CHECK_CODE
	);
	expect(pairingCheckCode(GOLDEN_CHECK_CODE)).toBe(GOLDEN_CHECK_CODE);
});

it("keeps Core's check code and never derives one from the device id", async () => {
	const { target } = serve(() =>
		Response.json({
			principal_id: "owner:local",
			devices: [
				device({
					check_code: GOLDEN_CHECK_CODE,
					device_id: GOLDEN_DEVICE_ID,
					state: "pending",
				}),
				{
					...device({ device_id: "dev-0123456789abcdef" }),
					check_code: undefined,
				},
				{ ...device({ device_id: "bad" }), check_code: "zdx-mj5" },
			],
		})
	);
	const snapshot = await listPairedPhones(target);
	expect(
		snapshot.devices.map((entry) => [entry.device_id, entry.check_code])
	).toEqual([
		[GOLDEN_DEVICE_ID, GOLDEN_CHECK_CODE],
		["dev-0123456789abcdef", null],
		["bad", null],
	]);
});

it("accepts only well-formed Crockford check codes", () => {
	expect(pairingCheckCode("0AB-YZ9")).toBe("0AB-YZ9");
	for (const value of [
		undefined,
		null,
		42,
		"",
		"ABCDEF",
		"ABC-DEFG",
		"abc-def",
		"ABI-DEF",
		"ABC-DLO",
		"ABU-DEF",
	]) {
		expect(pairingCheckCode(value)).toBeNull();
	}
});
