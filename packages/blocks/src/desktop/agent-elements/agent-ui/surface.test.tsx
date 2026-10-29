// The single-screen generative-UI rules: which `ui.render` a surface host (the
// Island) shows, and how the transcript collapses render calls to chips when a
// host is present.

import { describe, expect, test } from "bun:test";
import type { ChatStatus, UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRenderer } from "../tools/tool-renderer.tsx";
import { TurnEndCards } from "../turn-end-cards.tsx";
import {
	type AgentUiSurface,
	agentUiSurfaceFromPart,
	agentUiSurfaceKey,
	deriveLiveAgentUiSurface,
	dismissAgentUiSurface,
	displayedAgentUiSurface,
	EMPTY_AGENT_UI_SURFACE_SELECTION,
	reconcileAgentUiSurfaceSelection,
	reopenAgentUiSurface,
} from "./surface.ts";
import {
	AgentUiSurfaceChip,
	type AgentUiSurfaceHost,
	AgentUiSurfaceHostProvider,
} from "./surface-context.tsx";

const flightsSpec = {
	root: "card",
	elements: {
		card: { type: "Card", props: { title: "Flights" }, children: [] },
	},
};
const cheaperSpec = {
	root: "card",
	elements: {
		card: { type: "Card", props: { title: "Cheaper flights" }, children: [] },
	},
};

function uiRenderPart(
	toolCallId: string,
	spec: unknown,
	state = "output-available"
) {
	return {
		input: { spec, title: "Flights" },
		state,
		toolCallId,
		toolName: "ui.render",
		type: "dynamic-tool",
	};
}

function user(id: string, text: string): UIMessage {
	return { id, parts: [{ text, type: "text" }], role: "user" };
}

function assistant(id: string, parts: unknown[]): UIMessage {
	// SAFETY: test fixtures model Core's wire parts, which the AI SDK types narrowly.
	return { id, parts: parts as UIMessage["parts"], role: "assistant" };
}

const text = (value: string) => ({ text: value, type: "text" });

describe("agentUiSurfaceFromPart", () => {
	test("accepts typed and dynamic ui.render parts with a complete spec", () => {
		expect(
			agentUiSurfaceFromPart(uiRenderPart("call-1", flightsSpec), "x")
		).toEqual({
			format: undefined,
			id: "call-1",
			spec: flightsSpec,
			title: "Flights",
		});
		expect(
			agentUiSurfaceFromPart(
				{
					input: { format: "a2ui", spec: [] },
					state: "input-available",
					type: "tool-ui.render",
				},
				"fallback"
			)
		).toMatchObject({ format: "a2ui", id: "fallback" });
	});

	test("ignores streaming input, missing specs, and other tools", () => {
		expect(
			agentUiSurfaceFromPart(
				uiRenderPart("c", flightsSpec, "input-streaming"),
				"x"
			)
		).toBeNull();
		expect(
			agentUiSurfaceFromPart(uiRenderPart("c", undefined), "x")
		).toBeNull();
		expect(
			agentUiSurfaceFromPart(
				{
					input: { spec: flightsSpec },
					toolName: "bash",
					type: "dynamic-tool",
				},
				"x"
			)
		).toBeNull();
		expect(agentUiSurfaceFromPart(text("hi"), "x")).toBeNull();
	});
});

describe("deriveLiveAgentUiSurface", () => {
	const firstTurn = [
		user("u1", "find flights"),
		assistant("a1", [text("Here you go"), uiRenderPart("call-1", flightsSpec)]),
	];

	test("is empty for a conversation without UI", () => {
		expect(deriveLiveAgentUiSurface([], "ready")).toEqual({
			surface: null,
			updating: false,
		});
		expect(
			deriveLiveAgentUiSurface(
				[user("u1", "hi"), assistant("a1", [text("hello")])],
				"ready"
			).surface
		).toBeNull();
	});

	test("shows the latest screen rendered in the current turn", () => {
		const live = deriveLiveAgentUiSurface(firstTurn, "ready");
		expect(live.surface?.spec).toBe(flightsSpec);
		expect(live.updating).toBe(false);
	});

	test("keeps the previous screen, updating, while a follow-up runs", () => {
		for (const status of ["submitted", "streaming"] satisfies ChatStatus[]) {
			const live = deriveLiveAgentUiSurface(
				[...firstTurn, user("u2", "cheaper?"), assistant("a2", [])],
				status
			);
			expect(live.surface?.spec).toBe(flightsSpec);
			expect(live.updating).toBe(true);
		}
	});

	test("reshapes to the follow-up turn's screen", () => {
		const live = deriveLiveAgentUiSurface(
			[
				...firstTurn,
				user("u2", "cheaper?"),
				assistant("a2", [uiRenderPart("call-2", cheaperSpec)]),
			],
			"streaming"
		);
		expect(live.surface?.spec).toBe(cheaperSpec);
		expect(live.updating).toBe(false);
	});

	test("disappears when a finished turn rendered no UI", () => {
		const messages = [
			...firstTurn,
			user("u2", "thanks"),
			assistant("a2", [text("Anytime")]),
		];
		expect(deriveLiveAgentUiSurface(messages, "ready").surface).toBeNull();
	});

	test("keeps the previous screen, not updating, after a failed turn", () => {
		const live = deriveLiveAgentUiSurface(
			[...firstTurn, user("u2", "cheaper?")],
			"error"
		);
		expect(live.surface?.spec).toBe(flightsSpec);
		expect(live.updating).toBe(false);
	});
});

describe("surface selection (dismiss / reopen / supersede)", () => {
	const screenA: AgentUiSurface = { id: "call-1", spec: flightsSpec };
	const screenB: AgentUiSurface = { id: "call-2", spec: cheaperSpec };
	const live = (surface: AgentUiSurface | null) =>
		reconcileAgentUiSurfaceSelection(EMPTY_AGENT_UI_SURFACE_SELECTION, surface);

	test("closing a screen hides that render, even while a follow-up updates it", () => {
		const closed = dismissAgentUiSurface(live(screenA), screenA);
		expect(displayedAgentUiSurface(closed, screenA)).toBeNull();
		// The follow-up turn keeps the same render up (`updating`): still closed.
		expect(reconcileAgentUiSurfaceSelection(closed, screenA)).toBe(closed);
	});

	test("a new render of an identical spec shows again after a close", () => {
		const closed = dismissAgentUiSurface(live(screenA), screenA);
		const again: AgentUiSurface = {
			id: "call-3",
			spec: structuredClone(flightsSpec),
		};
		expect(agentUiSurfaceKey(again)).toBe(agentUiSurfaceKey(screenA));
		const next = reconcileAgentUiSurfaceSelection(closed, again);
		expect(displayedAgentUiSurface(next, again)).toBe(again);
	});

	test("A, B, then A again across turns shows the last render", () => {
		let selection = dismissAgentUiSurface(live(screenA), screenA);
		selection = reconcileAgentUiSurfaceSelection(selection, screenB);
		expect(displayedAgentUiSurface(selection, screenB)).toBe(screenB);
		const againA: AgentUiSurface = { id: "call-4", spec: flightsSpec };
		selection = reconcileAgentUiSurfaceSelection(selection, againA);
		expect(displayedAgentUiSurface(selection, againA)).toBe(againA);
	});

	test("reopening clears a close; a new render supersedes the reopened screen", () => {
		const closed = dismissAgentUiSurface(live(screenB), screenB);
		const reopened = reopenAgentUiSurface(closed, screenA);
		expect(displayedAgentUiSurface(reopened, screenB)).toBe(screenA);
		const reshown = reopenAgentUiSurface(closed, screenB);
		expect(displayedAgentUiSurface(reshown, screenB)).toBe(screenB);
		const newer: AgentUiSurface = { id: "call-5", spec: cheaperSpec };
		const superseded = reconcileAgentUiSurfaceSelection(reopened, newer);
		expect(displayedAgentUiSurface(superseded, newer)).toBe(newer);
	});

	test("closing a reopened screen falls back to the live one", () => {
		const reopened = reopenAgentUiSurface(live(screenB), screenA);
		const closed = dismissAgentUiSurface(reopened, screenA);
		expect(displayedAgentUiSurface(closed, screenB)).toBe(screenB);
	});
});

describe("surface host seam", () => {
	const host = (activeSpec: unknown): AgentUiSurfaceHost => ({
		activeKey:
			activeSpec === null
				? null
				: agentUiSurfaceKey({ id: "any", spec: activeSpec }),
		open: () => undefined,
	});

	test("surface identity survives the chat runtime re-snapshotting parts", () => {
		const cloned = structuredClone(flightsSpec);
		expect(agentUiSurfaceKey({ id: "a", spec: cloned })).toBe(
			agentUiSurfaceKey({ id: "b", spec: flightsSpec })
		);
		expect(agentUiSurfaceKey({ id: "a", spec: cheaperSpec })).not.toBe(
			agentUiSurfaceKey({ id: "a", spec: flightsSpec })
		);
	});

	test("the chip marks the on-screen spec and offers to reopen others", () => {
		const surface = { id: "call-1", spec: flightsSpec, title: "Flights" };
		const onScreen = renderToStaticMarkup(
			<AgentUiSurfaceChip host={host(flightsSpec)} surface={surface} />
		);
		expect(onScreen).toContain("On screen");
		const offScreen = renderToStaticMarkup(
			<AgentUiSurfaceChip host={host(cheaperSpec)} surface={surface} />
		);
		expect(offScreen).toContain("Show");
	});

	test("a ui.render tool row renders inline without a host, a chip with one", () => {
		const part = uiRenderPart("call-1", flightsSpec);
		const props = {
			chatStatus: "ready" as const,
			// SAFETY: fixture mirrors Core's dynamic-tool wire part.
			part: part as never,
		};
		const inline = renderToStaticMarkup(<ToolRenderer {...props} />);
		expect(inline).toContain('data-slot="agent-ui"');
		const chip = renderToStaticMarkup(
			<AgentUiSurfaceHostProvider value={host(flightsSpec)}>
				<ToolRenderer {...props} />
			</AgentUiSurfaceHostProvider>
		);
		expect(chip).toContain('data-slot="agent-ui-surface-chip"');
		expect(chip).not.toContain('data-slot="agent-ui"');
	});

	test("a turn-end json-render card becomes a chip under a host", () => {
		const cards = [
			{ id: "m1-json-0", kind: "json-render" as const, spec: flightsSpec },
		];
		expect(renderToStaticMarkup(<TurnEndCards cards={cards} />)).toContain(
			'data-slot="turn-json-render-card"'
		);
		const chip = renderToStaticMarkup(
			<AgentUiSurfaceHostProvider value={host(null)}>
				<TurnEndCards cards={cards} />
			</AgentUiSurfaceHostProvider>
		);
		expect(chip).toContain('data-slot="agent-ui-surface-chip"');
	});
});
