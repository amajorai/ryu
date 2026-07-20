// Smoke test for the generative-UI chain: an agent spec → json-render Renderer →
// the project's `@ryu/ui` components. Renders to static markup (no DOM) and asserts
// the real component output, the inline fallback for an unknown component type, and
// the whole-spec fallback that keeps a structurally-broken spec from crashing chat.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentUI } from "./agent-ui.tsx";

const sampleSpec = {
	root: "card",
	elements: {
		card: {
			type: "Card",
			props: { title: "Deploy status" },
			children: ["body"],
		},
		body: {
			type: "Stack",
			props: { gap: "sm" },
			children: ["msg", "bar", "badge"],
		},
		msg: {
			type: "Text",
			props: { text: "Building…", muted: true },
			children: [],
		},
		bar: { type: "Progress", props: { value: 60 }, children: [] },
		badge: { type: "Badge", props: { text: "running" }, children: [] },
	},
};

describe("AgentUI", () => {
	test("renders the spec into @ryu/ui components", () => {
		const html = renderToStaticMarkup(<AgentUI spec={sampleSpec} />);
		expect(html).toContain("Deploy status");
		expect(html).toContain("Building…");
		expect(html).toContain("running");
		// A real @ryu/ui Card carries the shadcn token class.
		expect(html).toContain("bg-card");
	});

	test("renders an optional title above the UI", () => {
		const html = renderToStaticMarkup(
			<AgentUI spec={sampleSpec} title="Status" />
		);
		expect(html).toContain("Status");
	});

	test("renders an unknown component type inertly instead of throwing", () => {
		const spec = {
			root: "x",
			elements: { x: { type: "NotAComponent", props: {}, children: [] } },
		};
		const html = renderToStaticMarkup(<AgentUI spec={spec} />);
		expect(html).toContain("unknown component");
		expect(html).toContain("NotAComponent");
	});

	test("falls back to raw JSON for a structurally-broken spec", () => {
		const html = renderToStaticMarkup(<AgentUI spec={{ not: "a spec" }} />);
		expect(html.toLowerCase()).toContain("be rendered");
		expect(html).toContain("not");
	});
});
