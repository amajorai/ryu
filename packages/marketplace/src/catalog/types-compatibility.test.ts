// packages/marketplace/src/catalog/types-compatibility.test.ts
//
// The host-floor evaluator, imported from its own module. `compatibility.test.ts`
// covers the full grammar through the `types.ts` facade; this pins the module the
// facade re-exports, so a broken re-export or a half-moved evaluator fails here.

import { describe, expect, test } from "bun:test";
import * as facade from "./types.ts";
import {
	blockingUnmet,
	type CompatibilityVerdict,
	evaluateCompatibility,
} from "./types-compatibility.ts";

describe("types-compatibility", () => {
	test("the facade re-exports the module's evaluator unchanged", () => {
		expect(facade.evaluateCompatibility).toBe(evaluateCompatibility);
		expect(facade.blockingUnmet).toBe(blockingUnmet);
	});

	test("a known desktop version below its floor is a blocking too_old", () => {
		const verdict = evaluateCompatibility(
			{ desktop: ">=1.2.0" },
			{ desktop: "1.1.9" }
		);
		expect(verdict).toEqual({
			compatible: false,
			unmet: [
				{
					code: "too_old",
					present: "1.1.9",
					required: ">=1.2.0",
					surface: "desktop",
				},
			],
		});
		expect(blockingUnmet(verdict)).toHaveLength(1);
	});

	test("an unobservable surface stays advisory and does not block", () => {
		const verdict: CompatibilityVerdict = evaluateCompatibility(
			{ ryu: ">=0.1.0" },
			{}
		);
		expect(verdict.compatible).toBe(true);
		expect(verdict.unmet).toEqual([
			{ code: "unknown", required: ">=0.1.0", surface: "core" },
		]);
		expect(blockingUnmet(verdict)).toEqual([]);
	});
});
