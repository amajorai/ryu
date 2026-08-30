import { afterEach, describe, expect, test } from "bun:test";

const savedEnvironment = { ...process.env };
// `target.ts` derives its exported default at module load. Keep this test's
// release-default assertion independent of the CI job's own RYU_PROFILE=dev.
delete process.env.RYU_PROFILE;
const { buildTarget, coreUrlForProfile } = await import("./target.ts");

afterEach(() => {
	for (const key of [
		"RYU_CORE_URL",
		"RYU_CORE_TOKEN",
		"RYU_PROFILE",
		"RYU_DIR",
	]) {
		delete process.env[key];
	}
	Object.assign(process.env, savedEnvironment);
});

describe("MCP Core target", () => {
	test("uses the loopback Core default", () => {
		delete process.env.RYU_CORE_URL;
		expect(buildTarget().url).toBe("http://127.0.0.1:7980");
	});

	test("trims an explicitly configured Core URL", () => {
		process.env.RYU_CORE_URL = "  http://core.example.test:7980/  ";
		expect(buildTarget().url).toBe("http://core.example.test:7980/");
	});
});

describe("MCP target", () => {
	test("uses the matching port for every supported profile", () => {
		expect(coreUrlForProfile("release")).toBe("http://127.0.0.1:7980");
		expect(coreUrlForProfile("dev")).toBe("http://127.0.0.1:8980");
		expect(coreUrlForProfile("nightly")).toBe("http://127.0.0.1:10980");
	});

	test("uses the explicit remote URL and node bearer", () => {
		process.env.RYU_CORE_URL = "https://node.example";
		process.env.RYU_CORE_TOKEN = "node-secret";

		expect(buildTarget()).toEqual({
			url: "https://node.example",
			token: "node-secret",
		});
	});
});
