// Proof of the island's declarative-view wiring: the SAME `ViewContribution` a
// plugin ships (and the desktop renders full-size) rendered here through the island
// mapping unit `IslandViewPanel` → `IslandDeclarativeView`. This is the seam the
// island runtime mounts (`CompanionPanel` → a `views` contribution over IPC → this
// panel), extracted as a pure component so the `contribution → spec → renderer` path
// is testable without the Electron/IPC shell. If the mapping breaks, this test breaks.

import { describe, expect, test } from "bun:test";
import { helloListDetailContribution } from "@ryu/app-host/views";
import { renderToStaticMarkup } from "react-dom/server";
import { IslandViewPanel } from "./declarative-view.tsx";

describe("IslandViewPanel", () => {
	test("renders the shared helloListDetail contribution in the island idiom", () => {
		const html = renderToStaticMarkup(
			<IslandViewPanel view={helloListDetailContribution} />
		);
		// The contribution's title heads the panel.
		expect(html).toContain("Hello");
		// Every list item's title renders (the same spec the desktop renders).
		expect(html).toContain("Alpha");
		expect(html).toContain("Beta");
		expect(html).toContain("Gamma");
		// The list-detail action panel renders the primary action.
		expect(html).toContain("Refresh");
		// A tone badge from the spec surfaces.
		expect(html).toContain("new");
	});

	test("degrades a spec-less contribution to a quiet unavailable row", () => {
		const html = renderToStaticMarkup(
			<IslandViewPanel
				view={{ id: "bare", view: "list-detail", plugin: "x" }}
			/>
		);
		expect(html).toContain("View unavailable");
		expect(html).not.toContain("Alpha");
	});

	test("shell-fetched sourceItems replace the spec's static items", () => {
		const html = renderToStaticMarkup(
			<IslandViewPanel
				sourceItems={[
					{
						item: { id: "q-1", title: "Write docs", accessory: "open" },
						raw: { id: "q-1", title: "Write docs", status: "open" },
					},
				]}
				view={{
					id: "quest-board",
					view: "list-detail",
					plugin: "com.ryu.quests",
					spec: {
						view: "list-detail",
						items: [],
						emptyText: "No quests yet.",
						itemActions: [
							{
								id: "complete",
								label: "Complete",
								style: "primary",
								http: {
									method: "POST",
									path: "/api/quests/{{item.id}}/complete",
								},
							},
						],
					},
				}}
			/>
		);
		// The fetched row renders (not the empty text) and the per-item action
		// surfaces in the foot ActionPanel for the default (first) selection.
		expect(html).toContain("Write docs");
		expect(html).not.toContain("No quests yet.");
		expect(html).toContain("Complete");
	});
});
