// apps/desktop/src/lib/api/operations.test.ts
//
// Whose operation is it. Core records the user who started an operation
// (`ownerUserId`) when the start carried a verified user JWT, and sends it in
// lists, the stream and reads. A surface may show, stop, retry and register
// folders only from the signed-in user's own operations, and the Live section
// gives a card only to those. While the client sends an identity it cannot
// name, nothing is its own.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { registerVaultOwnerSource } from "@/lib/session-owner.ts";

/** The session bearer the auth client holds, `null` when signed out. */
let bearer: string | null = null;

mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getToken: () => null,
	getActiveToken: () => bearer,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));

const {
	isOwnOperation,
	operationViewer,
	parseOperation,
	sessionOperationViewer,
} = await import("./operations.ts");

const LOCAL = { token: "node-token", url: "http://127.0.0.1:7980" };
const LAN = { token: "node-token", url: "http://192.168.1.20:7980" };
const MANAGED = {
	token: null,
	url: "https://node.example.com",
	userJwt: "delegation",
};

function wire(over: Record<string, unknown> = {}) {
	return {
		createdAt: "2026-11-18T10:00:00.000Z",
		id: "op_1",
		kind: "import.setup",
		status: "running",
		title: ".claude",
		updatedAt: "2026-11-18T10:00:00.000Z",
		...over,
	};
}

describe("the owner of an operation", () => {
	test("the client keeps the owner Core sends", () => {
		expect(parseOperation(wire({ ownerUserId: "user-a" }))?.ownerUserId).toBe(
			"user-a"
		);
		expect(parseOperation(wire())?.ownerUserId).toBeUndefined();
	});
});

describe("whether the client presents an identity to a node", () => {
	test("a signed-in user presents one where the client sends the user JWT", () => {
		expect(operationViewer(LOCAL, "user-a", true)).toEqual({
			presentsIdentity: true,
			userId: "user-a",
		});
		expect(operationViewer(MANAGED, "user-a", true).presentsIdentity).toBe(
			true
		);
		// Cleartext to another host: the account JWT is withheld.
		expect(operationViewer(LAN, "user-a", true).presentsIdentity).toBe(false);
	});

	test("signed out with no delegation, the client presents none", () => {
		expect(operationViewer(LOCAL, null, false)).toEqual({
			presentsIdentity: false,
			userId: null,
		});
	});

	test("a live session bearer is an identity, also when the user cannot be named", () => {
		// A placeholder account or an unverified bearer: no verified user id, but
		// the client still mints the account JWT from the bearer and sends it.
		expect(operationViewer(LOCAL, null, true)).toEqual({
			presentsIdentity: true,
			userId: null,
		});
		// Where the account JWT is withheld the bearer sends nothing.
		expect(operationViewer(LAN, null, true).presentsIdentity).toBe(false);
	});

	test("a managed delegation is an identity, with or without a session", () => {
		// The delegation is sent as it is, with no look at the session.
		expect(operationViewer(MANAGED, null, false)).toEqual({
			presentsIdentity: true,
			userId: null,
		});
		expect(operationViewer(MANAGED, null, true).presentsIdentity).toBe(true);
	});
});

describe("the viewer of the live session", () => {
	let unregister: () => void = () => undefined;
	function session(userId: string | null, token: string | null) {
		unregister();
		unregister = registerVaultOwnerSource({
			accountCount: () => (token ? 1 : 0),
			verifiedActiveUserId: () => userId,
		});
		bearer = token;
	}
	afterEach(() => {
		unregister();
		unregister = () => undefined;
		bearer = null;
	});

	test("a verified account is named and presented", () => {
		session("user-a", "session-bearer");
		expect(sessionOperationViewer(LOCAL)).toEqual({
			presentsIdentity: true,
			userId: "user-a",
		});
	});

	test("a placeholder account is presented and not named", () => {
		// The offline sign-in fallback: a bearer is live, no user id is verified.
		session(null, "session-bearer");
		expect(sessionOperationViewer(LOCAL)).toEqual({
			presentsIdentity: true,
			userId: null,
		});
		expect(isOwnOperation({}, sessionOperationViewer(LOCAL))).toBe(false);
	});

	test("signed out, a managed node's delegation is still presented", () => {
		session(null, null);
		expect(sessionOperationViewer(MANAGED).presentsIdentity).toBe(true);
		expect(sessionOperationViewer(LOCAL)).toEqual({
			presentsIdentity: false,
			userId: null,
		});
	});
});

describe("whose operation a surface may take as its own", () => {
	const signedIn = operationViewer(LOCAL, "user-a", true);
	const signedOut = operationViewer(LOCAL, null, false);
	// The client sends an identity it cannot name.
	const unnamedLocal = operationViewer(LOCAL, null, true);
	const unnamedManaged = operationViewer(MANAGED, null, false);

	test("an operation the signed-in user started is theirs", () => {
		expect(isOwnOperation({ ownerUserId: "user-a" }, signedIn)).toBe(true);
	});

	test("another user's operation is never theirs", () => {
		expect(isOwnOperation({ ownerUserId: "user-b" }, signedIn)).toBe(false);
		expect(isOwnOperation({ ownerUserId: "user-b" }, signedOut)).toBe(false);
	});

	test("an operation without an owner is theirs only when they present no identity", () => {
		// A client that presents no identity starts ownerless operations itself:
		// the one operator of a node that is not bound to an organization.
		expect(isOwnOperation({}, signedOut)).toBe(true);
		expect(isOwnOperation({}, operationViewer(LAN, "user-a", true))).toBe(true);
		// A client that presents its user starts owned operations, so an
		// ownerless one was started by someone else.
		expect(isOwnOperation({}, signedIn)).toBe(false);
	});

	test("while the client sends an identity it cannot name, nothing is theirs", () => {
		// Core may take this caller for the node's admin and list everything.
		expect(isOwnOperation({}, unnamedLocal)).toBe(false);
		expect(isOwnOperation({}, unnamedManaged)).toBe(false);
		expect(isOwnOperation({ ownerUserId: "user-a" }, unnamedLocal)).toBe(false);
		expect(isOwnOperation({ ownerUserId: "user-a" }, unnamedManaged)).toBe(
			false
		);
	});
});
