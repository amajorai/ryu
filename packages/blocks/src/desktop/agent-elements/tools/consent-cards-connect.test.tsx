import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	ConsentActions,
	RequestConfirmationCode,
} from "../consent-host-context.tsx";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { ConnectAppCard } = await import("./consent-cards-connect.tsx");

function actions(overrides: Partial<ConsentActions>): ConsentActions {
	return {
		accessOptions: [
			{ description: "Asks first.", id: "risk_based", label: "Ask first" },
		],
		connectApp: () => Promise.resolve(),
		describeApp: () =>
			Promise.resolve({
				available: true,
				connected: false,
				logoUrl: null,
				name: "Mail",
				unavailableKind: null,
				unavailableReason: null,
			}),
		findPlugins: () => Promise.resolve([]),
		installPlugin: () => Promise.resolve({ enabled: true }),
		isPluginEnabled: () => Promise.resolve(true),
		nodeKey: "http://node-a",
		openPluginListing: () => undefined,
		...overrides,
	};
}

function buttonByText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === text
	);
}

/** Type into a React-controlled input. */
function typeInto(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	input.focus();
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	// react-dom may load before the DOM is registered and then listens for
	// the legacy keyup path instead of `input`.
	input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

async function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	await act(async () => root.render(node));
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

const request = {
	app: "mail",
	pluginId: "@ryu/mail",
	provider: "mcp" as const,
	reason: "To read mail.",
};

describe("hosted sign-in confirmation code", () => {
	test("the card asks for the browser's code and hands it to the host", async () => {
		const codes: string[] = [];
		const followUps: string[] = [];
		const view = await mount(
			<ConnectAppCard
				actions={actions({
					async connectApp(_request, _level, signal, requestCode) {
						const ask = requestCode as RequestConfirmationCode;
						codes.push(await ask(null, signal));
						// A wrong code: the host asks again with the refusal.
						codes.push(await ask("The code did not match.", signal));
					},
				})}
				onFollowUp={(text) => {
					followUps.push(text);
				}}
				request={request}
			/>
		);
		try {
			await act(async () => {
				buttonByText(view.container, "Connect Mail")?.click();
			});
			const input = view.container.querySelector("input");
			expect(input).not.toBeNull();
			expect(view.container.textContent).toContain(
				"Enter the code your browser shows to finish connecting Mail"
			);
			expect(buttonByText(view.container, "Finish")?.disabled).toBe(true);
			await act(async () => {
				typeInto(input as HTMLInputElement, " abcd-efgh ");
			});
			await act(async () => {
				buttonByText(view.container, "Finish")?.click();
			});
			expect(view.container.textContent).toContain("The code did not match.");
			await act(async () => {
				typeInto(
					view.container.querySelector("input") as HTMLInputElement,
					"WXYZ-2345"
				);
			});
			await act(async () => {
				buttonByText(view.container, "Finish")?.click();
			});
			expect(codes).toEqual(["abcd-efgh", "WXYZ-2345"]);
			expect(view.container.textContent).toContain("Connected");
			expect(followUps).toEqual(['I connected "mail". Please continue.']);
		} finally {
			await view.unmount();
		}
	});

	test("stop waiting while the code is asked cancels without messaging the agent", async () => {
		const followUps: string[] = [];
		let cancelled = false;
		const view = await mount(
			<ConnectAppCard
				actions={actions({
					async connectApp(_request, _level, signal, requestCode) {
						try {
							await (requestCode as RequestConfirmationCode)(null, signal);
						} catch (error) {
							cancelled =
								error instanceof DOMException && error.name === "AbortError";
							throw error;
						}
					},
				})}
				onFollowUp={(text) => {
					followUps.push(text);
				}}
				request={request}
			/>
		);
		try {
			await act(async () => {
				buttonByText(view.container, "Connect Mail")?.click();
			});
			await act(async () => {
				buttonByText(view.container, "Stop waiting")?.click();
			});
			expect(cancelled).toBe(true);
			expect(buttonByText(view.container, "Connect Mail")).toBeDefined();
			expect(followUps).toEqual([]);
		} finally {
			await view.unmount();
		}
	});
});
