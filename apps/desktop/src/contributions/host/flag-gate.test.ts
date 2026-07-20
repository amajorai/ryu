// Flag-gate assertions for the third-party plugin host (WF3, `flag_off_no_code`).
//
// `shouldLoadThirdPartyUi` is desktop code (`@/src/lib/experimental.ts`) and does
// NOT move with the app-host package, so its adversarial assertions live here in
// desktop rather than in `@ryu/app-host`'s `adversarial.test.ts` (which only tests
// the moved host modules). Kept pure so it asserts without a DOM.

import { describe, expect, it } from "bun:test";
import { shouldLoadThirdPartyUi } from "@/src/lib/experimental.ts";

describe("flag gate keeps third-party code off by default", () => {
	it("never loads code when the experimental flag is OFF", () => {
		expect(shouldLoadThirdPartyUi(false, true)).toBe(false);
		expect(shouldLoadThirdPartyUi(false, false)).toBe(false);
	});

	it("loads code only when the flag is ON and the plugin carries a bundle", () => {
		expect(shouldLoadThirdPartyUi(true, false)).toBe(false);
		expect(shouldLoadThirdPartyUi(true, true)).toBe(true);
	});
});
