// A turn-end artifact card renders under the inline tool row's artifact id, so
// a page's saved `ryu.state` follows it from the streaming row to the card.

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactHostValue } from "./artifact-host-context.tsx";
import type { ArtifactTurnEndCard } from "./turn-end-cards.ts";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { TurnEndCards } = await import("./turn-end-cards.tsx");
const { ArtifactHostContext } = await import("./artifact-host-context.tsx");

async function renderedIds(card: ArtifactTurnEndCard): Promise<string[]> {
	const ids: string[] = [];
	const host: ArtifactHostValue = {
		fetchContent: async () => null,
		openInPanel: () => undefined,
		openInTab: () => undefined,
		Renderer: ({ id }) => {
			ids.push(id);
			return <span>{id}</span>;
		},
		submitFollowUp: () => undefined,
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<ArtifactHostContext.Provider value={host}>
				<TurnEndCards cards={[card]} />
			</ArtifactHostContext.Provider>
		);
	});
	await act(async () => root.unmount());
	container.remove();
	return ids;
}

const artifact = { content: "<p>game</p>", kind: "html", title: "Game" };

describe("turn-end artifact card id", () => {
	test("uses the inline row's id when the tool call is known", async () => {
		const ids = await renderedIds({
			artifact,
			id: "turn-1-artifact-2",
			kind: "artifact",
			toolCallId: "call-7",
		});
		expect(new Set(ids)).toEqual(new Set(["artifact-call-7"]));
	});

	test("falls back to the card id without a tool call", async () => {
		const ids = await renderedIds({
			artifact,
			id: "turn-1-artifact-2",
			kind: "artifact",
		});
		expect(new Set(ids)).toEqual(new Set(["turn-1-artifact-2"]));
	});
});
