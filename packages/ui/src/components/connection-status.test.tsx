import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
	ConnectionStatusDot,
	ConnectionStatusToast,
} from "./connection-status.tsx";

describe("ConnectionStatusDot", () => {
	test("uses semantic states for online, offline, and checking", () => {
		for (const state of ["online", "offline", "checking"] as const) {
			const html = renderToStaticMarkup(
				<ConnectionStatusDot label={`Node: ${state}`} state={state} />
			);
			expect(html).toContain(`data-connection-dot-state="${state}"`);
			expect(html).toContain(`aria-label="Node: ${state}"`);
		}
	});
});

describe("ConnectionStatusToast", () => {
	test("does not add shell chrome while online", () => {
		expect(
			renderToStaticMarkup(
				<ConnectionStatusToast nodeName="Local" phase="online" />
			)
		).toBe("");
	});

	test("explains an offline device without a retry action", () => {
		const html = renderToStaticMarkup(
			<ConnectionStatusToast
				nodeName="Local"
				onRetry={() => undefined}
				phase="offline"
			/>
		);
		expect(html).toContain('data-connection-phase="offline"');
		expect(html).toContain("Offline mode");
		expect(html).toContain("Waiting for connectivity");
		expect(html).not.toContain(">Retry<");
	});

	test("offers retry only when the selected node is unreachable", () => {
		const html = renderToStaticMarkup(
			<ConnectionStatusToast
				nodeName="Design node"
				onRetry={() => undefined}
				phase="node-unreachable"
			/>
		);
		expect(html).toContain("Node offline");
		expect(html).toContain("Can’t reach Design node");
		expect(html).toContain('data-slot="connection-status-retry"');
		expect(html).toContain('aria-label="Retry"');
	});

	test("renders the brief restored confirmation", () => {
		const html = renderToStaticMarkup(
			<ConnectionStatusToast nodeName="Design node" phase="online" restored />
		);
		expect(html).toContain('data-connection-restored="true"');
		expect(html).toContain("Connection restored");
	});

	test("uses a borderless glass surface with room after the text", () => {
		const html = renderToStaticMarkup(
			<ConnectionStatusToast nodeName="Local" phase="offline" />
		);
		expect(html).toContain("bg-connection-toast-surface/65");
		expect(html).toContain("backdrop-blur-2xl");
		const surfaceClass = html.match(
			/<div[^>]*class="([^"]*)"[^>]*data-slot="connection-status-surface"/
		)?.[1];
		expect(surfaceClass).toBeDefined();
		const surfaceClasses = new Set(surfaceClass?.split(/\s+/));
		expect(surfaceClasses.has("pl-2")).toBe(true);
		expect(surfaceClasses.has("pr-4")).toBe(true);
		expect(html).toContain("whitespace-nowrap");
		expect(html).not.toContain("truncate");
		expect(html).toContain('data-slot="connection-status-detail"');
		expect(html).not.toContain("border-white/15");
		expect(html).not.toContain("ring-white/10 ring-inset");
		expect(html).not.toContain("ring-1 ring-inset");
	});
});

describe("ConnectionStatusToast layout=strip", () => {
	test("renders nothing while online", () => {
		expect(
			renderToStaticMarkup(
				<ConnectionStatusToast layout="strip" nodeName="Local" phase="online" />
			)
		).toBe("");
	});

	test("renders one inline sentence and one Retry action, with no pill chrome", () => {
		const html = renderToStaticMarkup(
			<ConnectionStatusToast
				layout="strip"
				nodeName="Design node"
				onRetry={() => undefined}
				phase="node-unreachable"
			/>
		);
		expect(html).toContain('data-slot="status-strip"');
		expect(html).toContain('data-tone="warning"');
		expect(html).toContain("Node offline.");
		expect(html).toContain("Can’t reach Design node");
		expect(html).toContain('data-slot="connection-status-retry"');
		expect(html).toContain(">Retry<");
		const stripClass = /class="([^"]*)" data-slot="status-strip"/.exec(
			html
		)?.[1];
		expect(stripClass).toContain("h-8");
		expect(stripClass).not.toContain("shadow");
		expect(stripClass).not.toContain("backdrop-blur");
		expect(stripClass).not.toContain("rounded");
	});
});
