// Shared inline-script fragments: literal escaping, indentation, and the runtime
// behavior of the argument marshaller and theme-state projection.

import { describe, expect, it } from "bun:test";
import {
	COMPANION_THEME_STATE_SCRIPT,
	HOSTED_EXTERNAL_LINKS_SCRIPT,
	indentGeneratedScript,
	RPC_ARGS_SCRIPT,
	scriptSafe,
} from "./companion-script-fragments.ts";

describe("scriptSafe", () => {
	it("escapes characters that could leave an inline script", () => {
		expect(scriptSafe("</script>&\u2028\u2029")).toBe(
			'"\\u003c/script\\u003e\\u0026\\u2028\\u2029"'
		);
		expect(scriptSafe(undefined)).toBe("null");
	});
});

describe("indentGeneratedScript", () => {
	it("prefixes every line, including blank ones", () => {
		expect(indentGeneratedScript("a\n\nb", "  ")).toBe("  a\n  \n  b");
	});
});

describe("RPC_ARGS_SCRIPT", () => {
	const rpcArgs = new Function(`${RPC_ARGS_SCRIPT}\nreturn rpcArgs;`)() as (
		value: unknown
	) => unknown;

	it("drops undefined members of plain objects recursively", () => {
		expect(rpcArgs([{ a: 1, b: undefined, c: { d: undefined } }])).toEqual([
			{ a: 1, c: {} },
		]);
	});

	it("passes class instances through unchanged", () => {
		const date = new Date(0);
		expect(rpcArgs({ when: date })).toEqual({ when: date });
		expect((rpcArgs({ when: date }) as { when: Date }).when).toBe(date);
	});
});

describe("COMPANION_THEME_STATE_SCRIPT", () => {
	it("projects mode and state tokens onto the document root", () => {
		const attributes = new Map<string, string>();
		const classes = new Set<string>();
		const style = new Map<string, string>();
		const root = {
			classList: {
				toggle: (name: string, on: boolean) =>
					on ? classes.add(name) : classes.delete(name),
			},
			removeAttribute: (name: string) => attributes.delete(name),
			setAttribute: (name: string, value: string) =>
				attributes.set(name, value),
			style: {
				setProperty: (name: string, value: string) => style.set(name, value),
			},
		};
		const applyThemeState = new Function(
			"document",
			`${COMPANION_THEME_STATE_SCRIPT}\nreturn applyThemeState;`
		)({ documentElement: root }) as (tokens: Record<string, string>) => void;
		attributes.set("data-high-contrast", "on");
		applyThemeState({
			"--ryu-theme-mode": "dark",
			"--ryu-color-scheme": "dark",
			"--ryu-animations": "off",
			"--ryu-high-contrast": "off",
		});
		expect([...classes]).toEqual(["dark"]);
		expect(attributes.get("data-ryu-theme")).toBe("dark");
		expect(attributes.get("data-ryu-animations")).toBe("off");
		expect(attributes.has("data-high-contrast")).toBe(false);
		expect(style.get("color-scheme")).toBe("dark");
	});
});

describe("HOSTED_EXTERNAL_LINKS_SCRIPT", () => {
	it("registers one capture-phase click listener", () => {
		const listeners: [string, boolean][] = [];
		new Function("document", "call", HOSTED_EXTERNAL_LINKS_SCRIPT)(
			{
				addEventListener: (type: string, _fn: unknown, capture: boolean) =>
					listeners.push([type, capture]),
			},
			() => Promise.resolve()
		);
		expect(listeners).toEqual([["click", true]]);
	});
});
