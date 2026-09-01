import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STARTUP_REALM,
	readStartupRealm,
	STARTUP_REALM_KEY,
} from "@/src/lib/product-mode.ts";
import { listSettingsByCategory } from "@/src/lib/settings-registry.ts";
import "./useStartupRealm.ts";

describe("startup realm setting", () => {
	test("defaults to Last used, which resolves to Bot for a new user", () => {
		expect(DEFAULT_STARTUP_REALM).toBe("last-used");
		expect(readStartupRealm()).toBe(DEFAULT_STARTUP_REALM);
	});

	test("registers the setting for General reset and search ownership", () => {
		const setting = listSettingsByCategory("general").find(
			(entry) => entry.id === "general.on-startup.realm"
		);
		expect(setting?.label).toBe("Realm on startup");
		expect(STARTUP_REALM_KEY).toBe("ryu:startup-realm");
	});
});
