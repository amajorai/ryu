import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectionStatusToast } from "./connection-status.tsx";

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
		expect(html).toContain(">Retry<");
	});

	test("renders the brief restored confirmation", () => {
		const html = renderToStaticMarkup(
			<ConnectionStatusToast nodeName="Design node" phase="online" restored />
		);
		expect(html).toContain('data-connection-restored="true"');
		expect(html).toContain("Connection restored");
	});
});
