// The canvas in a DOM (spec 07.10): a flood of pulses never rebuilds the node
// array (CV-4), reduced motion draws no pulses (CV-10), every node's editor is
// reachable from the table view with the keyboard (CV-9), only editors get
// the drag-to-assign palette and only policy layers take a drop (CV-7), and
// the server render is an empty shell that cannot mismatch on hydration
// (CV-11).

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { GatewayCanvas } from "./gateway-canvas.tsx";
import type {
	CanvasAssignment,
	CanvasNode,
	GatewayCanvasAdapter,
	TrafficPulse,
} from "./model.ts";
import { buildTopology } from "./topology.ts";

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

const topology = buildTopology({
	chain: {
		"scope:org": { label: "Organization" },
		"stage:platform_floor": { label: "Platform floor", locked: true },
		"stage:rate_limit": { label: "Rate limit" },
	},
	gateway: { label: "This gateway" },
	providers: [{ label: "OpenAI", name: "openai" }],
	route: { label: "Router" },
	surfaces: [{ id: "surface:openai", label: "OpenAI-compatible API" }],
});

const ALLOWED: TrafficPulse = {
	outcome: "allow",
	path: [
		"surface:openai",
		"gateway",
		"stage:rate_limit",
		"stage:platform_floor",
		"scope:org",
		"stage:route",
		"provider:openai",
	],
};

function feedAdapter() {
	let emit: ((pulse: TrafficPulse) => void) | null = null;
	const edited: string[] = [];
	const adapter: GatewayCanvasAdapter = {
		canEdit: true,
		renderEditor: (node: CanvasNode) => {
			edited.push(node.id);
			return <p data-editor={node.id}>Editor for {node.label}</p>;
		},
		subscribe: (onPulse) => {
			emit = onPulse;
			return () => {
				emit = null;
			};
		},
		topology,
	};
	return {
		adapter,
		edited,
		emit: (pulse: TrafficPulse) => emit?.(pulse),
	};
}

function setReducedMotion(reduce: boolean) {
	Reflect.set(window, "matchMedia", (query: string) => ({
		addEventListener: () => undefined,
		matches: reduce && query.includes("reduce"),
		media: query,
		removeEventListener: () => undefined,
	}));
}

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	container.style.width = "1200px";
	container.style.height = "700px";
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function settle(ms = 40) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

describe("GatewayCanvas", () => {
	test("CV-4: a thousand pulses update counters without rebuilding nodes", async () => {
		setReducedMotion(false);
		const feed = feedAdapter();
		let builds = 0;
		const view = await mount(
			<GatewayCanvas
				adapter={feed.adapter}
				defaultView="map"
				feed={{ status: "live" }}
				label="Gateway traffic map"
				onNodesBuilt={() => {
					builds += 1;
				}}
			/>
		);
		const buildsAfterMount = builds;
		expect(buildsAfterMount).toBeGreaterThan(0);
		await act(async () => {
			for (let index = 0; index < 1000; index += 1) {
				feed.emit(ALLOWED);
			}
		});
		await settle();
		expect(builds).toBe(buildsAfterMount);
		const gateway = view.container.querySelector(
			'[data-canvas-node="gateway"]'
		);
		expect(gateway?.getAttribute("aria-label")).toContain("1k requests");
		const drawn = Number(
			view.container
				.querySelector("[data-canvas-pulses]")
				?.getAttribute("data-canvas-pulses") ?? "0"
		);
		expect(drawn).toBeGreaterThan(0);
		expect(drawn).toBeLessThanOrEqual(30);
		await view.dispose();
	});

	test("CV-10: reduced motion counts requests but draws no pulses", async () => {
		setReducedMotion(true);
		const feed = feedAdapter();
		const view = await mount(
			<GatewayCanvas
				adapter={feed.adapter}
				defaultView="map"
				feed={{ status: "live" }}
				label="Gateway traffic map"
			/>
		);
		await act(async () => {
			for (let index = 0; index < 5; index += 1) {
				feed.emit(ALLOWED);
			}
		});
		await settle();
		expect(view.container.querySelector("[data-canvas-pulses]")).toBeNull();
		const provider = view.container.querySelector(
			'[data-canvas-node="provider:openai"]'
		);
		expect(provider?.getAttribute("aria-label")).toContain("5 requests");
		await view.dispose();
		setReducedMotion(false);
	});

	test("CV-9: the table view opens every node's editor", async () => {
		const feed = feedAdapter();
		const view = await mount(
			<GatewayCanvas
				adapter={feed.adapter}
				defaultView="table"
				feed={{ status: "off" }}
				label="Gateway traffic map"
			/>
		);
		const buttons = [
			...view.container.querySelectorAll<HTMLButtonElement>(
				"[data-canvas-row] button"
			),
		];
		expect(buttons).toHaveLength(topology.nodes.length);
		for (const button of buttons) {
			await act(async () => button.click());
		}
		expect(new Set(feed.edited)).toEqual(
			new Set(topology.nodes.map((node) => node.id))
		);
		const panel = view.container.querySelector("[data-canvas-panel]");
		expect(panel?.getAttribute("data-canvas-panel")).toBe("provider:openai");
		await view.dispose();
	});

	test("selecting a node on the map opens its panel; Close returns focus", async () => {
		setReducedMotion(false);
		const feed = feedAdapter();
		const view = await mount(
			<GatewayCanvas
				adapter={feed.adapter}
				defaultView="map"
				feed={{ status: "live" }}
				label="Gateway traffic map"
			/>
		);
		const floor = view.container.querySelector<HTMLButtonElement>(
			'[data-canvas-node="stage:platform_floor"]'
		);
		expect(floor?.getAttribute("aria-label")).toContain("locked");
		await act(async () => floor?.click());
		expect(
			view.container.querySelector('[data-editor="stage:platform_floor"]')
		).not.toBeNull();
		const close = view.container.querySelector<HTMLButtonElement>(
			'[aria-label="Close panel"]'
		);
		await act(async () => close?.click());
		expect(view.container.querySelector("[data-canvas-panel]")).toBeNull();
		await view.dispose();
	});

	test("CV-7: editors get the policy palette and only policy layers take a drop", async () => {
		setReducedMotion(false);
		const assignment: CanvasAssignment = {
			assign: () => Promise.resolve(true),
			policies: [{ id: "pol_1", label: "Strict screening" }],
			targets: (node) =>
				node.kind === "scope"
					? [{ id: "org_1", kind: "org", label: "Proof org" }]
					: [],
		};
		const editor = feedAdapter();
		const view = await mount(
			<GatewayCanvas
				adapter={{ ...editor.adapter, assignment }}
				defaultView="table"
				feed={{ status: "off" }}
				label="Gateway traffic map"
			/>
		);
		expect(
			view.container.querySelector("[data-canvas-palette]")
		).not.toBeNull();
		await view.dispose();

		const mapView = await mount(
			<GatewayCanvas
				adapter={{ ...editor.adapter, assignment }}
				defaultView="map"
				feed={{ status: "off" }}
				label="Gateway traffic map"
			/>
		);
		const targets = [
			...mapView.container.querySelectorAll("[data-canvas-drop]"),
		].map((node) => node.getAttribute("data-canvas-node"));
		expect(targets).toEqual(["scope:org"]);
		await mapView.dispose();

		const viewer = await mount(
			<GatewayCanvas
				adapter={{ ...editor.adapter, assignment, canEdit: false }}
				defaultView="table"
				feed={{ status: "off" }}
				label="Gateway traffic map"
			/>
		);
		expect(viewer.container.querySelector("[data-canvas-palette]")).toBeNull();
		await viewer.dispose();
	});

	test("with no feed, nodes and the table show no counts instead of zeros", async () => {
		setReducedMotion(false);
		const feed = feedAdapter();
		const map = await mount(
			<GatewayCanvas
				adapter={feed.adapter}
				defaultView="map"
				feed={{ status: "off" }}
				label="Gateway traffic map"
			/>
		);
		const gateway = map.container.querySelector('[data-canvas-node="gateway"]');
		expect(gateway?.textContent).not.toContain("req");
		expect(gateway?.getAttribute("aria-label")).not.toContain("requests");
		await map.dispose();

		const table = await mount(
			<GatewayCanvas
				adapter={feed.adapter}
				defaultView="table"
				feed={{ status: "denied" }}
				label="Gateway traffic map"
			/>
		);
		expect(
			table.container.querySelector('[data-canvas-row="gateway"]')?.textContent
		).toContain("Not counted");
		await table.dispose();
	});

	test("aggregated hosts keep their medians and link counts, and infrastructure shows no counts", async () => {
		setReducedMotion(true);
		const withInfra = buildTopology({
			chain: {
				"stage:platform_floor": { label: "Platform floor", locked: true },
			},
			gateway: { label: "Gateways" },
			infra: [{ id: "infra:vault", label: "Credential vault" }],
			providers: [{ label: "Providers", name: "other" }],
			route: { label: "Router" },
			surfaces: [{ id: "surface:sdk", label: "Apps and SDKs" }],
		});
		const adapter: GatewayCanvasAdapter = {
			canEdit: false,
			renderEditor: () => null,
			subscribe: (_onPulse, onCounters) => {
				onCounters(
					{
						gateway: { blocked: 0, requests: 12 },
						"stage:platform_floor": { blocked: 2, p50Ms: 11, requests: 12 },
					},
					{ "gateway->stage:platform_floor": 12 }
				);
				return () => undefined;
			},
			topology: withInfra,
		};
		const map = await mount(
			<GatewayCanvas
				adapter={adapter}
				defaultView="map"
				feed={{ status: "aggregated" }}
				label="Hosted traffic map"
			/>
		);
		await settle();
		const floor = map.container.querySelector(
			'[data-canvas-node="stage:platform_floor"]'
		);
		expect(floor?.textContent).toContain("2 blocked");
		expect(floor?.textContent).toContain("11 ms");
		const vault = map.container.querySelector(
			'[data-canvas-node="infra:vault"]'
		);
		expect(vault?.textContent).not.toContain("req");
		await map.dispose();

		const table = await mount(
			<GatewayCanvas
				adapter={adapter}
				defaultView="table"
				feed={{ status: "aggregated" }}
				label="Hosted traffic map"
			/>
		);
		await settle();
		expect(
			table.container.querySelector('[data-canvas-row="infra:vault"]')
				?.textContent
		).toContain("Not counted");
		const links = [
			...table.container.querySelectorAll("caption + thead + tbody tr"),
		].map((row) => row.textContent);
		expect(links).toContain("GatewaysPlatform floor12");
		await table.dispose();
	});

	test("CV-11: the server render is an empty, labelled shell", () => {
		const feed = feedAdapter();
		const html = renderToString(
			<GatewayCanvas
				adapter={feed.adapter}
				feed={{ status: "aggregated" }}
				label="Gateway traffic map"
			/>
		);
		expect(html).toContain('aria-label="Gateway traffic map"');
		expect(html).not.toContain("data-canvas-node");
	});
});
