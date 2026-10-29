import { createElement, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
	Asset,
	Scene,
} from "../../../../apps-store/video-studio/shared/project.ts";
import { SceneContactSheet } from "../../../../apps-store/video-studio/ui/src/SceneContactSheet.tsx";
interface PreviewProps {
	assets: Asset[];
	scenes: Scene[];
	project: { width: number; height: number };
}
const context = Reflect.get(window.ryu ?? {}, "context") as {
	fixtureNonce: string;
	fixtureProps: PreviewProps;
};
if (!context?.fixtureNonce || !Array.isArray(context.fixtureProps.assets)) {
	throw new Error("Missing controlled preview context.");
}
interface ReceivedCompletion {
	path: string;
	outcome: "accepted" | "refused";
}
const receivedCompletions: ReceivedCompletion[] = [];
let renderReceivedCompletions = () => {};
const app = window.ryu?.app;
if (!app) {
	throw new Error("Missing actual injected app request bridge.");
}
const originalRequest = app.request.bind(app);
app.request = (input) => {
	const actualPromise = originalRequest(input);
	const observe = (outcome: ReceivedCompletion["outcome"]) => {
		// Observe the real child-side RPC promise, then let its production async
		// consumers run before flushing the fixture's completion output.
		requestAnimationFrame(() => {
			receivedCompletions.push({ path: input.path, outcome });
			flushSync(renderReceivedCompletions);
		});
	};
	void actualPromise.then(
		() => observe("accepted"),
		() => observe("refused")
	);
	return actualPromise;
};
function Widget() {
	const [props, setProps] = useState(context.fixtureProps);
	const [status, setStatus] = useState("");
	const [completed, setCompleted] = useState<ReceivedCompletion[]>([]);
	renderReceivedCompletions = () => setCompleted([...receivedCompletions]);
	useEffect(() => {
		const select = (event: MessageEvent) => {
			if (
				event.source !== window.parent ||
				event.data?.kind !== "video-preview-fixture-select" ||
				event.data?.nonce !== context.fixtureNonce
			) {
				return;
			}
			setStatus("");
			setProps(event.data.props as PreviewProps);
		};
		window.addEventListener("message", select);
		return () => window.removeEventListener("message", select);
	}, []);
	return createElement(
		"main",
		null,
		createElement(SceneContactSheet, { ...props, onStatus: setStatus }),
		createElement("output", { "data-testid": "preview-status" }, status),
		createElement(
			"output",
			{ "data-testid": "received-preview-completions", hidden: true },
			JSON.stringify(completed)
		)
	);
}
const root = document.getElementById("widget-root");
if (!root) {
	throw new Error("Missing preview widget root.");
}
createRoot(root).render(createElement(Widget));
