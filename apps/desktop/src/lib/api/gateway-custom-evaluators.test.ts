// apps/desktop/src/lib/api/gateway-custom-evaluators.test.ts
//
// Saving a custom evaluator restarts the gateway only when the config receipt
// asks for it. Current gateways apply custom evaluators live and answer
// `applied.restartRequired: false`; an older gateway without the receipt still
// needs the restart to load them.

import { describe, expect, it } from "bun:test";
import { configUpdateNeedsRestart } from "./gateway.ts";

describe("configUpdateNeedsRestart", () => {
	it("skips the restart when the gateway applied the change live", () => {
		expect(
			configUpdateNeedsRestart({
				applied: { live: true, restartRequired: false },
				ok: true,
			})
		).toBe(false);
	});

	it("restarts when the receipt asks for it or is missing", () => {
		expect(
			configUpdateNeedsRestart({ applied: { restartRequired: true }, ok: true })
		).toBe(true);
		expect(configUpdateNeedsRestart({ ok: true })).toBe(true);
		expect(configUpdateNeedsRestart({ applied: null, ok: true })).toBe(true);
		expect(configUpdateNeedsRestart({ applied: {}, ok: true })).toBe(true);
	});
});
