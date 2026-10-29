import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("localStorage" in globalThis)) {
	GlobalRegistrator.register();
}

const getRealtimeJwt = mock(async () => "verified-user-jwt");
mock.module("@/src/lib/realtime/jwt.ts", () => ({ getRealtimeJwt }));

const {
	accountJwtForTarget,
	authenticatedFetch,
	realtimeJwtForTarget,
	USER_JWT_HEADER,
} = await import("./client.ts");
const { fetchSidecarStatus, fetchSystemInfo, fetchSystemStatus } = await import(
	"./system.ts"
);
const { uploadUserFile } = await import("./uploads.ts");

const originalFetch = globalThis.fetch;
interface FetchCall {
	init?: RequestInit;
	input: RequestInfo | URL;
}
const fetchCalls: FetchCall[] = [];
const fetchMock = mock(
	async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		fetchCalls.push({ init, input });
		return Response.json({});
	}
);
Reflect.set(globalThis, "fetch", fetchMock);

const TARGET = { token: "node-secret", url: "https://node.example/" };

function lastCall(): FetchCall {
	const call = fetchCalls.at(-1);
	if (!call) {
		throw new Error("Expected an authenticated fetch call");
	}
	return call;
}

function lastHeaders(): Headers {
	return new Headers(lastCall().init?.headers);
}

afterAll(() => {
	Reflect.set(globalThis, "fetch", originalFetch);
});

beforeEach(() => {
	fetchCalls.length = 0;
	getRealtimeJwt.mockClear();
	localStorage.clear();
	localStorage.setItem("ryu_client_id", "desktop-client-1");
	localStorage.setItem(
		"ryu_oidc_user",
		JSON.stringify({ email: "person@example.com", name: "Ryu User" })
	);
});

describe("authenticatedFetch", () => {
	test("keeps an encoded JSON body and sends node plus verified user identity", async () => {
		const body = JSON.stringify({ enabled: true });
		await authenticatedFetch(TARGET, "/api/config", {
			body,
			headers: { "X-Request-Kind": "json" },
			method: "POST",
		});

		expect(String(lastCall().input)).toBe("https://node.example/api/config");
		expect(lastCall().init?.body).toBe(body);
		const headers = lastHeaders();
		expect(headers.get("Authorization")).toBe("Bearer node-secret");
		expect(headers.get(USER_JWT_HEADER)).toBe("verified-user-jwt");
		expect(headers.get("X-Ryu-Client-Id")).toBe("desktop-client-1");
		expect(headers.get("X-Ryu-Client-Label")).toBe("Desktop");
		expect(headers.get("X-Ryu-Surface")).toBe("desktop");
		expect(headers.get("X-Ryu-User-Id")).toBe("person%40example.com");
		expect(headers.get("X-Ryu-User-Name")).toBe("Ryu%20User");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("X-Request-Kind")).toBe("json");
	});

	test("passes FormData through and lets the browser own its content type", async () => {
		const form = new FormData();
		form.set("file", new Blob(["content"]), "document.txt");
		await authenticatedFetch(TARGET, "/api/uploads", {
			body: form,
			headers: { "Content-Type": undefined },
			method: "POST",
		});

		expect(lastCall().init?.body).toBe(form);
		expect(lastHeaders().has("Content-Type")).toBe(false);
		expect(lastHeaders().get(USER_JWT_HEADER)).toBe("verified-user-jwt");
	});

	test("passes a binary body through without changing its declared media type", async () => {
		const bytes = new Blob([new Uint8Array([1, 2, 3])]);
		await authenticatedFetch(TARGET, "/api/binary", {
			body: bytes,
			headers: { "Content-Type": "application/octet-stream" },
			method: "PUT",
		});

		expect(lastCall().init?.body).toBe(bytes);
		expect(lastHeaders().get("Content-Type")).toBe("application/octet-stream");
		expect(lastHeaders().get(USER_JWT_HEADER)).toBe("verified-user-jwt");
	});

	test("preserves stream options and refuses auth or identity overrides", async () => {
		const controller = new AbortController();
		await authenticatedFetch(TARGET, "/api/events/all", {
			cache: "no-store",
			headers: {
				Accept: "text/event-stream",
				Authorization: "Bearer attacker",
				"content-type": null,
				[USER_JWT_HEADER]: "forged-user-jwt",
				"X-Ryu-Client-Id": "forged-client",
			},
			method: "GET",
			signal: controller.signal,
		});

		expect(lastCall().init?.cache).toBe("no-store");
		expect(lastCall().init?.signal).toBe(controller.signal);
		const headers = lastHeaders();
		expect(headers.get("Accept")).toBe("text/event-stream");
		expect(headers.has("Content-Type")).toBe(false);
		expect(headers.get("Authorization")).toBe("Bearer node-secret");
		expect(headers.get(USER_JWT_HEADER)).toBe("verified-user-jwt");
		expect(headers.get("X-Ryu-Client-Id")).toBe("desktop-client-1");
	});

	test("node status reads keep node admission and omit the reusable account JWT", async () => {
		for (const readStatus of [
			fetchSystemInfo,
			fetchSystemStatus,
			fetchSidecarStatus,
		]) {
			await readStatus(TARGET);

			const headers = lastHeaders();
			expect(headers.get("Authorization")).toBe("Bearer node-secret");
			expect(headers.has(USER_JWT_HEADER)).toBe(false);
		}
		expect(getRealtimeJwt).not.toHaveBeenCalled();
	});
});

describe("uploadUserFile", () => {
	test("sends a non-Latin-1 file name as an encoded query, never a raw header", async () => {
		const fileName = "Screenshot 2026-10-17 at 9.41.00\u202fAM 雪.png";
		fetchMock.mockImplementationOnce(async (input, init) => {
			fetchCalls.push({ init, input });
			return Response.json({ id: "doc-1", url: "/api/uploads/doc-1" });
		});
		const file = new File([new Uint8Array([1])], fileName, {
			type: "image/png",
		});

		const result = await uploadUserFile(TARGET, file);

		const url = new URL(String(lastCall().input));
		expect(url.pathname).toBe("/api/uploads");
		expect(url.searchParams.get("name")).toBe(fileName);
		expect(lastHeaders().has("x-filename")).toBe(false);
		expect(lastHeaders().get("Content-Type")).toBe("image/png");
		expect(result.fileName).toBe(fileName);
	});
});

describe("accountJwtForTarget", () => {
	test("withholds the account JWT from a node with no admission credential", async () => {
		// A LAN-discovered node, or one added from a `ryu://nodes/connect` link
		// without a token: nothing admits the request, so the account-wide token
		// must not reach whoever answers at that URL.
		for (const target of [
			{ token: null, url: "http://192.168.1.50:7980" },
			{ token: " ", url: "http://attacker.example:7980", userJwt: "" },
		]) {
			expect(await accountJwtForTarget(target)).toBeNull();
		}
		expect(getRealtimeJwt).not.toHaveBeenCalled();
	});

	test("keeps the account JWT for a node bearer or a managed delegation", async () => {
		expect(await accountJwtForTarget(TARGET)).toBe("verified-user-jwt");
		expect(
			await accountJwtForTarget({
				token: null,
				url: "https://managed.example",
				userJwt: "node-delegation",
			})
		).toBe("verified-user-jwt");
	});

	test("withholds the account JWT from a tokened node over cleartext HTTP", async () => {
		// A passive observer on the LAN or mesh path would read the header.
		for (const target of [
			{ token: "node-secret", url: "http://192.168.1.50:7980" },
			{ token: "node-secret", url: "http://team-node.example:7980" },
			{ token: "node-secret", url: "http://127.0.0.1.attacker.example" },
		]) {
			expect(await accountJwtForTarget(target)).toBeNull();
		}
		expect(getRealtimeJwt).not.toHaveBeenCalled();
	});

	test("keeps the account JWT over HTTP to a Core on this machine", async () => {
		for (const url of [
			"http://127.0.0.1:7980",
			"http://localhost:7980",
			"http://[::1]:7980",
		]) {
			expect(await accountJwtForTarget({ token: "node-secret", url })).toBe(
				"verified-user-jwt"
			);
		}
	});

	test("keeps the account JWT for a tokened node over HTTPS", async () => {
		expect(
			await accountJwtForTarget({
				token: "node-secret",
				url: "https://192.168.1.50:7980",
			})
		).toBe("verified-user-jwt");
	});
});

describe("realtimeJwtForTarget", () => {
	test("keeps a managed delegation where the account JWT is withheld", async () => {
		expect(
			await realtimeJwtForTarget({
				token: null,
				url: "http://192.168.1.50:7980",
				userJwt: "node-delegation",
			})
		).toBe("node-delegation");
		expect(
			await realtimeJwtForTarget({
				token: "node-secret",
				url: "http://192.168.1.50:7980",
			})
		).toBeNull();
		expect(
			await realtimeJwtForTarget({ token: null, url: "https://node.example" })
		).toBeNull();
		expect(getRealtimeJwt).not.toHaveBeenCalled();
	});

	test("uses the account JWT where it may be attached", async () => {
		expect(
			await realtimeJwtForTarget({
				token: null,
				url: "https://managed.example",
				userJwt: "node-delegation",
			})
		).toBe("verified-user-jwt");
		expect(
			await realtimeJwtForTarget({
				token: "node-secret",
				url: "http://127.0.0.1:7980",
			})
		).toBe("verified-user-jwt");
	});
});

describe("requestHeaders over cleartext HTTP", () => {
	test("a tokened LAN node keeps its bearer but gets no account JWT", async () => {
		await authenticatedFetch(
			{ token: "node-secret", url: "http://192.168.1.50:7980" },
			"/api/config"
		);

		const headers = lastHeaders();
		expect(headers.get("Authorization")).toBe("Bearer node-secret");
		expect(headers.has(USER_JWT_HEADER)).toBe(false);
		expect(headers.get("X-Ryu-Client-Id")).toBe("desktop-client-1");
		expect(getRealtimeJwt).not.toHaveBeenCalled();
	});

	test("a loopback node still gets the account JWT", async () => {
		await authenticatedFetch(
			{ token: "node-secret", url: "http://127.0.0.1:7980" },
			"/api/config"
		);

		expect(lastHeaders().get(USER_JWT_HEADER)).toBe("verified-user-jwt");
	});

	test("a managed delegation is still sent; the account JWT is not minted", async () => {
		await authenticatedFetch(
			{
				token: null,
				url: "http://192.168.1.50:7980",
				userJwt: "node-delegation",
			},
			"/api/config"
		);

		const headers = lastHeaders();
		expect(headers.get("Authorization")).toBe("Bearer node-delegation");
		expect(headers.get(USER_JWT_HEADER)).toBe("node-delegation");
		expect(getRealtimeJwt).not.toHaveBeenCalled();
	});
});

describe("direct account-JWT transports", () => {
	// Chat streams, realtime rooms, and WebSocket tickets attach the account JWT
	// themselves instead of going through `requestHeaders`. Each must apply the
	// same gate: `accountJwtForTarget`, `realtimeJwtForTarget`, or
	// `mayAttachAccountJwt` where the decision has to be made synchronously.
	const desktopSrc = join(import.meta.dir, "../..");
	const gateOwners = new Set(["lib/api/client.ts", "lib/realtime/jwt.ts"]);

	test("never mint the account JWT without the node admission gate", () => {
		const ungated = readdirSync(desktopSrc, {
			encoding: "utf8",
			recursive: true,
		})
			.map((file) => file.replaceAll("\\", "/"))
			.filter(
				(file) =>
					/\.tsx?$/.test(file) &&
					!/\.test\.tsx?$/.test(file) &&
					!gateOwners.has(file)
			)
			.filter((file) => {
				const source = readFileSync(join(desktopSrc, file), "utf8");
				return (
					source.includes("getRealtimeJwt(") &&
					!source.includes("mayAttachAccountJwt(")
				);
			});
		expect(ungated).toEqual([]);
	});
});
