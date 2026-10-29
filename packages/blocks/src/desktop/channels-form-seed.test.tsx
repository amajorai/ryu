import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelConfigView, ChannelsViewProps } from "./channels.tsx";

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

const { ChannelsView, defaultBehaviorSettings } = await import(
	"./channels.tsx"
);

function channel(): ChannelConfigView {
	return {
		...defaultBehaviorSettings(),
		agentId: null,
		channelType: "telegram",
		enabled: true,
		groupReplyMode: "mentions",
		id: "bot-1",
		model: null,
		name: "Saved name",
		secrets: {},
		systemPrompt: null,
		teamId: null,
	};
}

function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	input.focus();
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	// react-dom loads before the DOM is registered, so it listens for the
	// legacy keyup path instead of `input`.
	input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

test("a parent re-render with a fresh channel object keeps unsaved edits and surfaces a failed save", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const pendingSave = Promise.withResolvers<boolean>();
	const render = (props: Partial<ChannelsViewProps>) =>
		root.render(
			<ChannelsView
				agents={[]}
				channels={[channel()]}
				initialSelectedId="bot-1"
				loading={false}
				onSave={() => pendingSave.promise}
				{...props}
			/>
		);
	await act(async () => render({}));
	try {
		const name = container.querySelector<HTMLInputElement>("#channel-name");
		expect(name?.value).toBe("Saved name");
		await act(async () => {
			if (name) {
				typeInto(name, "Edited name");
			}
		});
		expect(name?.value).toBe("Edited name");

		const save = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Save changes"
		);
		await act(async () => save?.click());
		// The host flips `saving` and rebuilds its channel views inline.
		await act(async () => render({ channels: [channel()], saving: true }));
		expect(name?.value).toBe("Edited name");

		await act(async () => {
			pendingSave.resolve(false);
			await pendingSave.promise;
		});
		await act(async () => render({ channels: [channel()], saving: false }));
		expect(name?.value).toBe("Edited name");
		expect(container.textContent).toContain(
			"Couldn't save this channel. Please try again."
		);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
