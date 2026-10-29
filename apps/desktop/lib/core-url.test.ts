import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	resolveDefaultCoreUrl,
	VERSION_ACTIVATED_PORT_OFFSETS,
} from "./core-url.ts";

describe("default Core URL", () => {
	it("uses the standalone app namespace before the normal Vite URL", () => {
		expect(
			resolveDefaultCoreUrl("http://127.0.0.1:7980", "@ryu/expenses")
		).toBe("http://127.0.0.1:32571");
	});

	it("keeps the configured URL for the ordinary Desktop product", () => {
		expect(resolveDefaultCoreUrl("http://127.0.0.1:8980", "")).toBe(
			"http://127.0.0.1:8980"
		);
	});

	it("follows the profile a canary/nightly bundle's version activates", () => {
		expect(
			resolveDefaultCoreUrl(
				"http://127.0.0.1:7980",
				"",
				"0.4.1-canary.20260804.36"
			)
		).toBe("http://127.0.0.1:9980");
		expect(resolveDefaultCoreUrl(undefined, "", "0.4.1-nightly.20260804")).toBe(
			"http://127.0.0.1:10980"
		);
		expect(resolveDefaultCoreUrl("http://127.0.0.1:7980", "", "0.4.1")).toBe(
			"http://127.0.0.1:7980"
		);
		expect(
			resolveDefaultCoreUrl("http://127.0.0.1:7980", "", "0.4.1-beta.2")
		).toBe("http://127.0.0.1:7980");
		expect(
			resolveDefaultCoreUrl("http://127.0.0.1:8980", "", "0.4.1-canary.1")
		).toBe("http://127.0.0.1:8980");
	});

	it("mirrors the version-activated profile ports in profile.rs", () => {
		const profileRs = readFileSync(
			path.join(import.meta.dir, "../src-tauri/src/profile.rs"),
			"utf8"
		);
		const activated = profileRs
			.match(/const VERSION_ACTIVATED_PROFILES: &\[&str\] = &\[([^\]]*)\]/)?.[1]
			?.match(/"([a-z]+)"/g)
			?.map((quoted) => quoted.slice(1, -1));
		expect(new Set(activated)).toEqual(
			new Set(VERSION_ACTIVATED_PORT_OFFSETS.keys())
		);
		for (const [channel, offset] of VERSION_ACTIVATED_PORT_OFFSETS) {
			expect(profileRs).toContain(`("${channel}", ${offset}),`);
		}
	});
});
