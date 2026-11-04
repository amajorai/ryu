// Drawers and panels docked at an inline edge slide in from that edge in
// either reading direction: under an Arabic UI a start-docked navigation
// drawer enters from the physical right, and an end-docked thread panel from
// the physical left.

import { describe, expect, test } from "bun:test";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityNavDrawer } from "./community-interface-nav-drawer.tsx";
import { PanelFrame } from "./knowledge-panel-parts.tsx";
import { RecordsThreadPanel } from "./records-parts.tsx";

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	events: [],
	groups: [],
	threads: [],
	version: 1,
};

function render(direction: "ltr" | "rtl", element: ReactElement): string {
	return renderToStaticMarkup(
		<DirectionProvider direction={direction}>
			<div dir={direction}>{element}</div>
		</DirectionProvider>
	);
}

const navDrawer = (direction: "ltr" | "rtl") =>
	render(
		direction,
		<CommunityNavDrawer
			nav={null}
			navOpen
			onClose={() => undefined}
			reduceMotion={false}
		/>
	);

const recordsPanel = (direction: "ltr" | "rtl") =>
	render(
		direction,
		<RecordsThreadPanel
			floating
			onClose={() => undefined}
			snapshot={SNAPSHOT}
			thread={undefined}
			threadView={null}
		/>
	);

const knowledgePanel = (direction: "ltr" | "rtl") =>
	render(
		direction,
		<PanelFrame label="Details" testId="knowledge-panel" wide={false}>
			{null}
		</PanelFrame>
	);

describe("inline-edge drawers under right-to-left", () => {
	test("a start-docked navigation drawer enters from the inline start", () => {
		expect(navDrawer("ltr")).toContain("translateX(-100%)");
		expect(navDrawer("rtl")).toContain("translateX(100%)");
		expect(navDrawer("rtl")).not.toContain("translateX(-100%)");
	});

	test("an end-docked thread panel enters from the inline end", () => {
		expect(recordsPanel("ltr")).toContain("translateX(12px)");
		expect(recordsPanel("rtl")).toContain("translateX(-12px)");
	});

	test("a transform-driven side panel enters from the inline end", () => {
		expect(knowledgePanel("ltr")).toContain("translateX(12px)");
		expect(knowledgePanel("rtl")).toContain("translateX(-12px)");
	});
});
