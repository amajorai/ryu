import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HostReducedMotionContext } = await import("./game3d-settings.tsx");
const { useReducedMotion } = await import("./reduced-motion.ts");

afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

function seen(wrap: (node: ReactNode) => ReactNode): boolean | null {
	let value: boolean | null = null;
	const Probe = () => {
		value = useReducedMotion();
		return null;
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(wrap(<Probe />)));
	act(() => root.unmount());
	container.remove();
	return value;
}

describe("the interfaces' reduced-motion hook", () => {
	test("follows the host's animations-off setting as a plain boolean", () => {
		expect(seen((node) => node)).toBe(false);
		expect(
			seen((node) => (
				<HostReducedMotionContext.Provider value>
					{node}
				</HostReducedMotionContext.Provider>
			))
		).toBe(true);
	});

	test("no interface source reads motion's system-only hook", () => {
		const offenders = readdirSync(import.meta.dir)
			.filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
			.filter((file) => file !== "reduced-motion.ts")
			.filter((file) => {
				const source = readFileSync(`${import.meta.dir}/${file}`, "utf8");
				return /import\s*\{[^}]*\buseReducedMotion\b[^}]*\}\s*from\s*"motion\/react"/.test(
					source
				);
			});
		expect(offenders).toEqual([]);
	});
});
