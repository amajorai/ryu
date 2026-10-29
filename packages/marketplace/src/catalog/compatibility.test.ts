// packages/marketplace/src/catalog/compatibility.test.ts
//
// The client-side half of the host-floor gate.
//
// Core is the authority that actually refuses an install, but it can only observe
// its own version and the Gateway's. Every other surface — desktop, island,
// mobile, extension, web, a separately-installed CLI — is reported as an advisory
// `unknown`. `evaluateCompatibility` is what lets a client that DOES know its own
// version turn that advisory into a real refusal, which is the entire reason a
// per-surface floor is worth declaring.
//
// The property under test throughout: this pass only ever REFINES. It must never
// mark something compatible that Core called incompatible, and it must never
// invent a refusal from a floor it cannot parse.

import { describe, expect, test } from "bun:test";
import { describeIncompatibility } from "./surface-labels.ts";
import {
	blockingUnmet,
	type CompatibilityVerdict,
	evaluateCompatibility,
} from "./types.ts";

describe("evaluateCompatibility", () => {
	test("no declared floors is compatible", () => {
		expect(evaluateCompatibility(null, {})).toEqual({
			compatible: true,
			unmet: [],
		});
	});

	test("a satisfied core floor is compatible", () => {
		const v = evaluateCompatibility({ ryu: ">=0.1.0" }, { core: "0.1.12" });
		expect(v.compatible).toBe(true);
		expect(v.unmet).toEqual([]);
	});

	test("an unsatisfied core floor blocks and reports both versions", () => {
		const v = evaluateCompatibility({ ryu: ">=0.2.0" }, { core: "0.1.12" });
		expect(v.compatible).toBe(false);
		expect(v.unmet).toEqual([
			{
				code: "too_old",
				present: "0.1.12",
				required: ">=0.2.0",
				surface: "core",
			},
		]);
	});

	/** The reason this function exists: Core reports a desktop floor as advisory
	 *  `unknown` because it cannot see the desktop. The desktop can. */
	test("overlaying a locally-known version upgrades unknown to too_old", () => {
		const serverVerdict: CompatibilityVerdict = {
			compatible: true,
			unmet: [{ code: "unknown", required: ">=2.0.0", surface: "desktop" }],
		};
		const v = evaluateCompatibility(
			{ desktop: ">=2.0.0", ryu: ">=0.1.0" },
			{ core: "0.1.12", desktop: "1.4.0" },
			serverVerdict
		);
		expect(v.compatible).toBe(false);
		expect(v.unmet).toContainEqual({
			code: "too_old",
			present: "1.4.0",
			required: ">=2.0.0",
			surface: "desktop",
		});
	});

	test("a surface this client also does not know stays advisory", () => {
		const v = evaluateCompatibility(
			{ mobile: ">=9.0.0", ryu: ">=0.1.0" },
			{ core: "0.1.12" }
		);
		expect(v.compatible).toBe(true);
		expect(v.unmet).toEqual([
			{ code: "unknown", required: ">=9.0.0", surface: "mobile" },
		]);
	});

	/** Server-only knowledge must survive: Core observes the Gateway via /health,
	 *  and a client that has no Gateway version of its own must not discard it. */
	test("a server verdict for a surface the client cannot see is preserved", () => {
		const serverVerdict: CompatibilityVerdict = {
			compatible: false,
			unmet: [
				{
					code: "too_old",
					present: "0.1.0",
					required: ">=0.5.0",
					surface: "gateway",
				},
			],
		};
		const v = evaluateCompatibility(
			{ gateway: ">=0.5.0", ryu: ">=0.1.0" },
			{ core: "0.1.12" },
			serverVerdict
		);
		expect(v.compatible).toBe(false);
		expect(v.unmet).toContainEqual({
			code: "too_old",
			present: "0.1.0",
			required: ">=0.5.0",
			surface: "gateway",
		});
	});

	/** Semver: a prerelease does not satisfy a plain `>=` range. Applying that
	 *  literally would mark every plugin incompatible on every nightly build, so
	 *  both sides compare on the release triple. */
	test("a prerelease host still satisfies a plain floor", () => {
		const v = evaluateCompatibility(
			{ ryu: ">=0.1.0" },
			{ core: "0.1.12-nightly.20260728.932" }
		);
		expect(v.compatible).toBe(true);
	});

	test("a v-prefixed version is accepted", () => {
		expect(
			evaluateCompatibility({ ryu: ">=0.1.0" }, { core: "v0.1.12" }).compatible
		).toBe(true);
	});

	test("a bare requirement means >=, not caret", () => {
		expect(
			evaluateCompatibility({ ryu: "1.2.0" }, { core: "2.0.0" }).compatible
		).toBe(true);
	});

	test("a comma conjunction is honoured, upper bound included", () => {
		expect(
			evaluateCompatibility({ ryu: ">=1.2, <2" }, { core: "1.9.0" }).compatible
		).toBe(true);
		expect(
			evaluateCompatibility({ ryu: ">=1.2, <2" }, { core: "2.0.0" }).compatible
		).toBe(false);
	});

	test("compares patch components in a release triple", () => {
		expect(
			evaluateCompatibility({ ryu: ">=1.2.3" }, { core: "1.2.2" }).compatible
		).toBe(false);
		expect(
			evaluateCompatibility({ ryu: ">=1.2.3" }, { core: "1.2.3" }).compatible
		).toBe(true);
	});

	/** The client is a display refinement, not the authority. A range grammar it
	 *  cannot parse must fall through to whatever Core said — never a made-up
	 *  refusal, and never a made-up pass. */
	test("an unparseable requirement defers to the server rather than inventing a verdict", () => {
		const v = evaluateCompatibility({ ryu: "^weird" }, { core: "0.1.12" });
		expect(v.compatible).toBe(true);
		expect(v.unmet).toEqual([]);

		const withServer = evaluateCompatibility(
			{ ryu: "^weird" },
			{ core: "0.1.12" },
			{
				compatible: false,
				unmet: [
					{
						code: "invalid_requirement",
						reason: "unexpected character",
						required: "^weird",
						surface: "core",
					},
				],
			}
		);
		expect(withServer.compatible).toBe(false);
	});

	test("an unparseable local version defers instead of blocking", () => {
		const v = evaluateCompatibility({ ryu: ">=0.1.0" }, { core: "garbage" });
		expect(v.compatible).toBe(true);
	});
});

describe("host API floor", () => {
	test("Core's host_api_too_old verdict survives the client re-evaluation and blocks", () => {
		const v = evaluateCompatibility(
			{ ryu: ">=0.1.0" },
			{},
			{
				compatible: false,
				unmet: [
					{
						code: "host_api_too_old",
						present: "1.17.0",
						required: "^1.18",
						surface: "core",
					},
				],
			}
		);
		expect(v.compatible).toBe(false);
		expect(v.unmet).toHaveLength(2);
		expect(v.unmet?.[0]).toEqual({
			code: "unknown",
			required: ">=0.1.0",
			surface: "core",
		});
		expect(blockingUnmet(v)).toEqual([
			{
				code: "host_api_too_old",
				present: "1.17.0",
				required: "^1.18",
				surface: "core",
			},
		]);
		expect(describeIncompatibility(v)).toBe(
			"Requires Ryu plugin host API ^1.18 (you have 1.17.0)"
		);
	});
});

describe("blockingUnmet", () => {
	test("advisory unknown is never blocking", () => {
		expect(
			blockingUnmet({
				compatible: true,
				unmet: [{ code: "unknown", required: ">=9.0.0", surface: "mobile" }],
			})
		).toEqual([]);
	});

	test("too_old and invalid_requirement both block", () => {
		expect(
			blockingUnmet({
				compatible: false,
				unmet: [
					{
						code: "too_old",
						present: "1.0.0",
						required: ">=2",
						surface: "core",
					},
					{
						code: "invalid_requirement",
						reason: "bad",
						required: "??",
						surface: "web",
					},
					{ code: "unknown", required: ">=9", surface: "mobile" },
				],
			})
		).toHaveLength(2);
	});
});

describe("describeIncompatibility", () => {
	test("null when only advisory entries are present", () => {
		expect(
			describeIncompatibility({
				compatible: true,
				unmet: [{ code: "unknown", required: ">=9.0.0", surface: "mobile" }],
			})
		).toBeNull();
	});

	test("null when there is nothing unmet at all", () => {
		expect(describeIncompatibility({ compatible: true, unmet: [] })).toBeNull();
		expect(describeIncompatibility(null)).toBeNull();
	});

	/** Core is shown as "Ryu", matching the `engines.ryu` key an author writes —
	 *  never "Headless node", which is meaningless to someone on a desktop app. */
	test("core is named Ryu and both versions are shown", () => {
		expect(
			describeIncompatibility({
				compatible: false,
				unmet: [
					{
						code: "too_old",
						present: "0.1.12",
						required: ">=0.2.0",
						surface: "core",
					},
				],
			})
		).toBe("Requires Ryu >=0.2.0 (you have 0.1.12)");
	});

	test("other surfaces use their display label", () => {
		expect(
			describeIncompatibility({
				compatible: false,
				unmet: [
					{
						code: "too_old",
						present: "1.4.0",
						required: ">=2.0.0",
						surface: "desktop",
					},
				],
			})
		).toBe("Requires Desktop >=2.0.0 (you have 1.4.0)");
	});
});
