import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { McpOAuthCodeForm } = await import("./McpOAuthCodeForm.tsx");

async function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	input.focus();
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

afterEach(() => {
	document.body.innerHTML = "";
});

test("the code form submits the trimmed code and shows a refusal", async () => {
	const submitted: string[] = [];
	const view = await mount(
		<McpOAuthCodeForm
			appName="Mail"
			error="OAuth confirmation code did not match"
			onSubmit={(code) => submitted.push(code)}
			pending={false}
		/>
	);
	const button = view.container.querySelector("button") as HTMLButtonElement;
	expect(view.container.textContent).toContain(
		"Enter the code your browser shows to finish connecting Mail"
	);
	expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
		"OAuth confirmation code did not match"
	);
	expect(button.disabled).toBe(true);
	await act(async () => {
		typeInto(
			view.container.querySelector("input") as HTMLInputElement,
			" abcd-efgh "
		);
	});
	expect(button.disabled).toBe(false);
	await act(async () => {
		button.click();
	});
	expect(submitted).toEqual(["abcd-efgh"]);
	await view.unmount();
});
