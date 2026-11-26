import { beforeEach, expect, test } from "bun:test";
import {
	modelContextParts,
	useModelContextStore,
} from "@ryu/app-host/model-context";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostCoreServices } from "./PluginHostPanel-services-core.ts";

// `ui.updateModelContext` writes text that the Ask Ryu transport appends to the
// person's own message. A tab that is open but not in front must add nothing,
// and what the tab in front adds carries the companion's real name.

const OWNER = "plugin:com.example.evil:page:n1";
const node = {
	url: "http://127.0.0.1:9/node",
	token: "fixture-node-token",
	userJwt: null,
};
const attribution = { escape: (text: string) => text };

/** One Companion tab's services, with the tab's focus in the test's hands. */
function companionServices(inFront: boolean) {
	const isActiveTabRef = { current: inFront };
	const context = {
		assistantContextRef: { current: [] },
		assistantOwner: OWNER,
		assistantSurfaceRef: { current: null },
		companion: { pluginId: "com.example.evil", name: "Evil App" },
		fileAccess: undefined,
		getActiveNode: () => node,
		i18n: { locale: "en" },
		isActiveTabRef,
		node,
		onRequestClose: undefined,
		toastHost: {},
	} as unknown as PluginHostServicesContext;
	return { isActiveTabRef, services: buildPluginHostCoreServices(context) };
}

beforeEach(() => {
	useModelContextStore.setState({ entries: {}, held: {} });
});

test("a tab that is not in front adds nothing to an Ask Ryu turn", async () => {
	const { services } = companionServices(false);
	const state = await services.updateModelContext?.({
		content: [{ type: "text", text: "x" }],
	});
	expect(modelContextParts("assistant")).toEqual([]);
	expect(modelContextParts("assistant", undefined, attribution)).toEqual([]);
	// The frame still reads back the context the host accepted from it.
	expect(state?.updateId).toBeString();
	expect(services.getModelContext?.()).toEqual(state ?? null);
	expect((await services.getGlobals?.())?.modelContext).toEqual(state ?? null);
});

test("the tab in front publishes under the companion's real name", async () => {
	const { services } = companionServices(true);
	await services.updateModelContext?.({
		content: [
			{
				type: "text",
				text: "x",
				annotations: { audience: ["assistant"] },
				_meta: { "openai/title": "Ryu" },
			},
		],
	});
	expect(useModelContextStore.getState().entries[OWNER]?.label).toBe(
		"Evil App"
	);
	const [part] = modelContextParts("assistant", undefined, attribution);
	const text = part?.type === "text" ? part.text : "";
	expect(text).toContain('supplied by the app "Evil App"');
	expect(text).toContain('<app-context app="Evil App">\nx\n</app-context>');
});

test("what a background tab published shows up only when its tab is in front again", async () => {
	const { isActiveTabRef, services } = companionServices(false);
	await services.updateModelContext?.({
		content: [{ type: "text", text: "first" }],
	});
	await services.updateModelContext?.({
		content: [{ type: "text", text: "second" }],
	});
	expect(modelContextParts("assistant")).toEqual([]);
	// Focus returns: the bridge releases the held entry.
	isActiveTabRef.current = true;
	useModelContextStore.getState().release(OWNER);
	const [part] = modelContextParts("assistant", undefined, attribution);
	const text = part?.type === "text" ? part.text : "";
	expect(text).toContain("\nsecond\n");
	expect(text).not.toContain("first");
	// A new update from the tab in front replaces it in place.
	await services.updateModelContext?.({
		content: [{ type: "text", text: "third" }],
	});
	expect(useModelContextStore.getState().held).toEqual({});
	expect(JSON.stringify(modelContextParts("assistant"))).toContain("third");
});
