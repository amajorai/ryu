import { expect, test } from "bun:test";
import { parseStoredServiceConfig } from "./config-contract.ts";

test("persisted Core settings retain the selected source and discard remote Shadow overrides", () => {
	expect(
		parseStoredServiceConfig(
			JSON.stringify({
				coreBaseUrl: "https://remote.example/",
				coreToken: "explicit-token",
				shadowBaseUrl: "https://foreign-shadow.example",
				engine: { pollIntervalSeconds: 30 },
			})
		)
	).toEqual({
		coreBaseUrl: "https://remote.example/",
		coreToken: "explicit-token",
		engine: { pollIntervalSeconds: 30 },
	});
});
test("malformed fields do not hide valid sibling settings", () => {
	expect(
		parseStoredServiceConfig(
			JSON.stringify({
				coreBaseUrl: "https://remote.example",
				coreToken: 42,
				engine: { pollIntervalSeconds: "fast", cooldownSeconds: 60 },
			})
		)
	).toEqual({
		coreBaseUrl: "https://remote.example",
		coreToken: undefined,
		engine: { pollIntervalSeconds: undefined, cooldownSeconds: 60 },
	});
	for (const raw of ["{", "null", "[]"]) {
		expect(parseStoredServiceConfig(raw)).toEqual({});
	}
});
