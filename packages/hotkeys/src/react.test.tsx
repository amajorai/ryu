import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	HotkeysProvider,
	useHotkeysAdmin,
	useOptionalHotkeyBinding,
} from "./react.tsx";
import type { HotkeyRegistry } from "./registry.ts";

const registry: HotkeyRegistry = [
	{
		id: "approval.accept",
		label: "Accept",
		category: "Approval",
		defaultBinding: " ctrl + enter ",
	},
	{
		id: "approval.decline",
		label: "Decline",
		category: "Approval",
		defaultBinding: null,
	},
];
function ReadBinding({ id }: { id: string }) {
	return createElement(
		"output",
		null,
		useOptionalHotkeyBinding(id) ?? "unbound"
	);
}
function CompareAdmin() {
	const binding = useOptionalHotkeyBinding("approval.accept");
	const admin = useHotkeysAdmin();
	return createElement(
		"output",
		null,
		binding === admin.bindings.get("approval.accept") ? binding : "different"
	);
}
function renderInProvider(id: string, actions = registry) {
	return renderToStaticMarkup(
		<HotkeysProvider registry={actions}>
			<ReadBinding id={id} />
		</HotkeysProvider>
	);
}
describe("optional effective hotkey binding", () => {
	test("returns null outside a provider for bound-looking and unknown IDs", () => {
		for (const id of ["approval.accept", "missing", "toString"]) {
			expect(renderToStaticMarkup(createElement(ReadBinding, { id }))).toBe(
				"<output>unbound</output>"
			);
		}
	});
	test("uses the same normalized effective Map entry as the real admin hook", () => {
		expect(renderInProvider("approval.accept")).toBe(
			"<output>Ctrl+enter</output>"
		);
		expect(
			renderToStaticMarkup(
				<HotkeysProvider registry={registry}>
					<CompareAdmin />
				</HotkeysProvider>
			)
		).toBe("<output>Ctrl+enter</output>");
	});
	test("returns null for actual default-unbound and absent registry entries", () => {
		for (const id of ["approval.decline", "missing", "toString"]) {
			expect(renderInProvider(id)).toBe("<output>unbound</output>");
		}
	});
	test("reads the nearest actual provider instead of a hardcoded action default", () => {
		const inner: HotkeyRegistry = [
			{
				id: "approval.accept",
				label: "Accept",
				category: "Approval",
				defaultBinding: "Alt+Y",
			},
		];
		const children = (
			<HotkeysProvider registry={inner}>
				<ReadBinding id="approval.accept" />
			</HotkeysProvider>
		);
		expect(
			renderToStaticMarkup(
				<HotkeysProvider registry={registry}>{children}</HotkeysProvider>
			)
		).toBe("<output>Alt+Y</output>");
	});
});
