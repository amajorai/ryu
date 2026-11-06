import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Under a right-to-left document, values written left to right in every
// locale (emails, URLs, paths and commands in the code variants) must keep a
// left-to-right field, other fields resolve by their content, and an explicit
// dir from the caller always wins.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Input } = await import("./input.tsx");
const { Textarea } = await import("./textarea.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderDir(node: ReactNode): Promise<string | null | undefined> {
	const container = document.createElement("div");
	container.setAttribute("dir", "rtl");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(node);
	});
	return container
		.querySelector("[data-slot=input], [data-slot=textarea]")
		?.getAttribute("dir");
}

describe("Input direction under RTL", () => {
	test("code-caption variant is left to right", async () => {
		expect(
			await renderDir(
				<Input placeholder="~/.ssh/id_ed25519" variant="code-caption" />
			)
		).toBe("ltr");
	});

	test("email type is left to right", async () => {
		expect(await renderDir(<Input type="email" />)).toBe("ltr");
	});

	test("text type resolves by content", async () => {
		expect(await renderDir(<Input type="text" />)).toBe("auto");
	});

	test("an explicit dir is kept", async () => {
		expect(await renderDir(<Input dir="rtl" type="email" />)).toBe("rtl");
	});
});

describe("Textarea direction under RTL", () => {
	test("code variant is left to right", async () => {
		expect(await renderDir(<Textarea variant="code" />)).toBe("ltr");
	});

	test("default variant resolves by content", async () => {
		expect(await renderDir(<Textarea />)).toBe("auto");
	});

	test("an explicit dir is kept", async () => {
		expect(await renderDir(<Textarea dir="rtl" variant="code" />)).toBe("rtl");
	});
});

describe("base.css direction rules", () => {
	const css = readFileSync(
		new URL("../styles/globals/base.css", import.meta.url),
		"utf8"
	);

	test("monospace spans without a dir take their first strong direction", () => {
		const rule = css.match(/:where\(\.font-mono\)[^{]*\{[^}]*\}/)?.[0];
		expect(rule).toContain(":where(:not([dir]))");
		expect(rule).toContain("unicode-bidi: plaintext;");
		expect(rule).not.toContain("direction: ltr");
	});

	test("an empty dir=auto field follows the surrounding direction", () => {
		const rule = css.match(
			/\[data-slot="input"\]\[dir="auto"\]:placeholder-shown[^{]*\{[^}]*\}/
		)?.[0];
		expect(rule).toContain(
			'[data-slot="textarea"][dir="auto"]:placeholder-shown'
		);
		expect(rule).toContain("direction: inherit;");
	});
});
