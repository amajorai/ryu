// apps/desktop/src/lib/experimental.test.ts
//
// Tests for the experimental-flag store. The security-shaped invariants:
//   - ordinary flags FAIL SAFE default-OFF: an absent/unrecognized/unreadable
//     value never silently runs experimental code;
//   - the `DEFAULT_ON_FLAGS` allowlist (the plugin-runtime flag) defaults ON,
//     but an EXPLICIT persisted opt-out ("0"/"false") always wins so a disabled
//     operator stays disabled;
//   - disabling a default-ON flag WRITES "0" (not remove), because removal would
//     silently re-enable it on next read;
//   - the pure `shouldRenderWidget` gate mirrors the flag with no DOM.
//
// A real DOM (localStorage) is required for the read/write half; register
// happy-dom before importing the module under test.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.window === "undefined") {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import {
	isExperimentalEnabled,
	PLUGIN_RUNTIME_FLAG,
	setExperimentalEnabled,
	shouldRenderWidget,
} from "./experimental.ts";

// An ordinary (default-OFF) experimental key, distinct from the allowlist.
const OFF_FLAG = "ryu:experimental-some-off-flag";

beforeEach(() => {
	localStorage.clear();
});

describe("isExperimentalEnabled — ordinary (default-OFF) flags", () => {
	test("absent → OFF (fail-safe)", () => {
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(false);
	});

	test("an unrecognized value → OFF, not truthy-coerced", () => {
		localStorage.setItem(OFF_FLAG, "yes");
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(false);
	});

	test('explicit "1"/"true" turns it ON', () => {
		localStorage.setItem(OFF_FLAG, "1");
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(true);
		localStorage.setItem(OFF_FLAG, "true");
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(true);
	});

	test('explicit "0"/"false" keeps it OFF', () => {
		localStorage.setItem(OFF_FLAG, "0");
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(false);
		localStorage.setItem(OFF_FLAG, "false");
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(false);
	});
});

describe("isExperimentalEnabled — DEFAULT_ON_FLAGS (plugin runtime)", () => {
	test("absent → ON (allowlisted default)", () => {
		expect(isExperimentalEnabled(PLUGIN_RUNTIME_FLAG)).toBe(true);
	});

	test("an unrecognized value falls back to the ON default", () => {
		localStorage.setItem(PLUGIN_RUNTIME_FLAG, "maybe");
		expect(isExperimentalEnabled(PLUGIN_RUNTIME_FLAG)).toBe(true);
	});

	test('an explicit "0"/"false" opt-out overrides the ON default', () => {
		localStorage.setItem(PLUGIN_RUNTIME_FLAG, "0");
		expect(isExperimentalEnabled(PLUGIN_RUNTIME_FLAG)).toBe(false);
		localStorage.setItem(PLUGIN_RUNTIME_FLAG, "false");
		expect(isExperimentalEnabled(PLUGIN_RUNTIME_FLAG)).toBe(false);
	});
});

describe("setExperimentalEnabled — persistence semantics", () => {
	test('enabling writes "1"', () => {
		setExperimentalEnabled(OFF_FLAG, true);
		expect(localStorage.getItem(OFF_FLAG)).toBe("1");
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(true);
	});

	test("disabling an ordinary flag REMOVES the key (its default is already OFF)", () => {
		setExperimentalEnabled(OFF_FLAG, true);
		setExperimentalEnabled(OFF_FLAG, false);
		expect(localStorage.getItem(OFF_FLAG)).toBeNull();
		expect(isExperimentalEnabled(OFF_FLAG)).toBe(false);
	});

	test('disabling a default-ON flag WRITES "0", not a removal (removal would re-enable)', () => {
		setExperimentalEnabled(PLUGIN_RUNTIME_FLAG, false);
		// The persistent escape hatch: an explicit "0" survives a re-read.
		expect(localStorage.getItem(PLUGIN_RUNTIME_FLAG)).toBe("0");
		expect(isExperimentalEnabled(PLUGIN_RUNTIME_FLAG)).toBe(false);
	});

	test("re-enabling a default-ON flag after opt-out flips it back on", () => {
		setExperimentalEnabled(PLUGIN_RUNTIME_FLAG, false);
		setExperimentalEnabled(PLUGIN_RUNTIME_FLAG, true);
		expect(localStorage.getItem(PLUGIN_RUNTIME_FLAG)).toBe("1");
		expect(isExperimentalEnabled(PLUGIN_RUNTIME_FLAG)).toBe(true);
	});

	test("dispatches the change event so mounted surfaces re-sync", () => {
		let fired = 0;
		const handler = () => {
			fired += 1;
		};
		window.addEventListener("ryu:experimental-changed", handler);
		try {
			setExperimentalEnabled(OFF_FLAG, true);
		} finally {
			window.removeEventListener("ryu:experimental-changed", handler);
		}
		expect(fired).toBe(1);
	});
});

describe("shouldRenderWidget", () => {
	test("mirrors the flag verbatim (pure, no DOM)", () => {
		expect(shouldRenderWidget(true)).toBe(true);
		expect(shouldRenderWidget(false)).toBe(false);
	});
});
