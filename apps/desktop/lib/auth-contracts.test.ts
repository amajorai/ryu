import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const { addAccount, getActiveToken, listAccounts, vaultHydrated } =
	await import("./auth-client.ts");
const { startDeviceAuth } = await import("./oauth.ts");
await vaultHydrated;
const fetchSpy = spyOn(globalThis, "fetch");

afterEach(() => {
	localStorage.clear();
	fetchSpy.mockReset();
});
afterAll(() => {
	fetchSpy.mockRestore();
	GlobalRegistrator.unregister();
});

test("vault reads preserve valid account extensions and reject malformed rows", () => {
	const account = {
		email: "person@example.com",
		image: null,
		name: "Person",
		token: "local-token",
		userId: "user-1",
		future: { retained: true },
	};
	localStorage.setItem("ryu_accounts", JSON.stringify([account]));
	expect(listAccounts()).toEqual([account]);
	localStorage.setItem(
		"ryu_accounts",
		JSON.stringify([{ ...account, token: 42 }])
	);
	expect(listAccounts()).toEqual([]);
	localStorage.setItem("ryu_accounts", "not-json");
	expect(listAccounts()).toEqual([]);
});

test("session profiles reject invalid identity before persisting the token", async () => {
	fetchSpy.mockResolvedValue(
		Response.json({ user: { id: 17, email: "person@example.com" } })
	);
	await expect(addAccount("local-token")).rejects.toThrow();
	expect(localStorage.getItem("ryu_session_token")).toBeNull();
	expect(listAccounts()).toEqual([]);
});

test("valid session profiles retain nullable defaults and persist the active account", async () => {
	fetchSpy.mockResolvedValue(
		Response.json({ user: { id: "user-1", email: null, future: true } })
	);
	expect(await addAccount("local-token")).toEqual({
		email: "",
		image: null,
		isAnonymous: false,
		name: null,
		token: "local-token",
		userId: "user-1",
	});
	expect(getActiveToken()).toBe("local-token");
	// The bearer is held in memory and the sealed native slot only.
	expect(localStorage.getItem("ryu_session_token")).toBeNull();
	expect(localStorage.getItem("ryu_accounts")).toBeNull();
});

test("device codes preserve optional field fallbacks and accept future response fields", async () => {
	fetchSpy.mockResolvedValue(
		Response.json({
			device_code: "device-code",
			user_code: "USER-CODE",
			verification_uri: 3,
			verification_uri_complete: null,
			interval: "slow",
			expires_in: null,
			future: true,
		})
	);
	expect(
		await startDeviceAuth("http://localhost:3000/", "/account")
	).toMatchObject({
		backendUrl: "http://localhost:3000",
		deviceCode: "device-code",
		userCode: "USER-CODE",
		interval: 5,
		expiresIn: 900,
	});
});

test("device authorization rejects absent or invalid required codes", async () => {
	for (const body of [
		null,
		{},
		{ device_code: 3, user_code: "CODE" },
		{ device_code: "", user_code: "CODE" },
	]) {
		fetchSpy.mockResolvedValue(Response.json(body));
		await expect(startDeviceAuth("http://localhost:3000")).rejects.toThrow(
			"Malformed device code response"
		);
	}
});
