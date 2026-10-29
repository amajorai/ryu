import { expect, test } from "bun:test";
import { configureSettingsApi, settingsApi } from "./api-client.ts";

test("native settings JSON and multipart requests retain the explicit backend origin", async () => {
	const previous = globalThis.fetch;
	const calls: { url: string; headers: Headers }[] = [];
	globalThis.fetch = Object.assign(
		async (...[input, options]: Parameters<typeof previous>) => {
			calls.push({
				url: String(input),
				headers: new Headers(options?.headers),
			});
			return Response.json({});
		},
		previous
	);
	try {
		configureSettingsApi({
			baseUrl: "https://api.example.com",
			getToken: () => "test-session",
		});
		await settingsApi.profile.updateName("Alice");
		await settingsApi.profile.uploadAvatar(new File(["avatar"], "avatar.png"));
		await settingsApi.organizations.uploadAvatar(
			"org-1",
			new File(["avatar"], "avatar.png")
		);
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(new URL(call.url).origin).toBe("https://api.example.com");
			expect(call.headers.get("authorization")).toBe("Bearer test-session");
		}
		for (const baseUrl of [
			"file:///etc/passwd",
			"https://u:p@example.com",
			"https://api.example.com/path",
		]) {
			expect(() =>
				configureSettingsApi({ baseUrl, getToken: () => null })
			).toThrow();
		}
	} finally {
		globalThis.fetch = previous;
	}
});
