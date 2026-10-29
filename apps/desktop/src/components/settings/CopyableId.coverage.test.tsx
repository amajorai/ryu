import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// The REAL shared `CopyableId` (the organization-id and user-id control used by
// the Gateway Workspace section and the Account tab), mounted in happy-dom with
// the shipping sileo Toaster and happy-dom's real Clipboard. Two ids are mounted
// side by side so the copied state is shown to belong to the row that was used.
// Keyboard activation and the blur reveal are CSS/browser-native, so they are
// proven in real Chromium by `e2e/unswept-a-copyable-id.spec.ts`.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { CopyableId } = await import("./shared/CopyableId.tsx");
const { button, flush, text, until } = await import(
	"./unswept-a.test-support.ts"
);

const ORG_ID = "org_01J9Z4WORKSPACEID";
const USER_ID = "user_01J9Z4ACCOUNTID";
// The first path command of each hugeicons glyph, as MorphIcon renders it.
const COPY_GLYPH = "M7.5 14.5";
const TICK_GLYPH = "M5 14.5";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<Toaster />
				<div data-row="org">
					<CopyableId label="organization ID" value={ORG_ID} />
				</div>
				<div data-row="user">
					<CopyableId value={USER_ID} />
				</div>
			</>
		)
	);
	await flush();
}

function glyph(name: string): string {
	return (
		button(name).querySelector("svg path")?.getAttribute("d")?.trim() ?? ""
	);
}

beforeEach(async () => {
	await navigator.clipboard.writeText("previous clipboard");
	await mount();
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	container?.remove();
	container = null;
	sileo.clear();
	document.body.replaceChildren();
});

test("Copy writes the exact id to the clipboard, toasts its label, and shows the check only on that row until it reverts", async () => {
	expect(document.querySelector('[data-row="org"] code')?.textContent).toBe(
		ORG_ID
	);
	expect(glyph("Copy organization ID").startsWith(COPY_GLYPH)).toBe(true);
	expect(glyph("Copy ID").startsWith(COPY_GLYPH)).toBe(true);

	const copiedAt = Date.now();
	await act(async () => button("Copy organization ID").click());
	expect(await navigator.clipboard.readText()).toBe(ORG_ID);
	await until(() => text().includes("Copied organization ID"), "copy toast");
	await until(
		() => glyph("Copy organization ID").startsWith(TICK_GLYPH),
		"copied check",
		1000,
		() => glyph("Copy organization ID")
	);
	// The other id's control is untouched by this copy.
	expect(glyph("Copy ID").startsWith(COPY_GLYPH)).toBe(true);
	expect(text()).not.toContain("Copy failed");

	// The check reverts to the copy glyph after the 1.5 s acknowledgement, not
	// before it.
	await until(
		() => glyph("Copy organization ID").startsWith(COPY_GLYPH),
		"copy glyph restored",
		3000,
		() => glyph("Copy organization ID")
	);
	expect(Date.now() - copiedAt).toBeGreaterThanOrEqual(1400);
});

test("the default label names the control and the toast, and copies the second id without disturbing the first", async () => {
	await act(async () => button("Copy ID").click());
	expect(await navigator.clipboard.readText()).toBe(USER_ID);
	await until(() => text().includes("Copied ID"), "default-label toast");
	expect(text()).not.toContain("Copied organization ID");
	await until(
		() => glyph("Copy ID").startsWith(TICK_GLYPH),
		"default-label check",
		1000,
		() => glyph("Copy ID")
	);
	expect(glyph("Copy organization ID").startsWith(COPY_GLYPH)).toBe(true);
});

test("a refused clipboard write reports Copy failed, keeps the previous clipboard, and never shows the copied check", async () => {
	const refused = spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
		new Error("clipboard denied")
	);
	try {
		await act(async () => button("Copy organization ID").click());
		await until(() => text().includes("Copy failed"), "failure toast");
		expect(refused).toHaveBeenCalledWith(ORG_ID);
		expect(text()).not.toContain("Copied organization ID");
		expect(await navigator.clipboard.readText()).toBe("previous clipboard");
		// Long enough for a morph to have finished had the state flipped.
		await act(async () => {
			await Bun.sleep(400);
		});
		expect(glyph("Copy organization ID").startsWith(COPY_GLYPH)).toBe(true);
	} finally {
		refused.mockRestore();
	}

	// The control recovers on the next attempt once the clipboard accepts.
	await act(async () => button("Copy organization ID").click());
	expect(await navigator.clipboard.readText()).toBe(ORG_ID);
	await until(() => text().includes("Copied organization ID"), "retry toast");
});
