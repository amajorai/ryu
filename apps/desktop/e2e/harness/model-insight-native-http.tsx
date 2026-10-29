import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { createRoot } from "react-dom/client";
import { ModelMenuContent } from "../../components/agent-elements/input/model-menu-content.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
const allowed = new Set(["paid", "free", "missing", "refused", "authority"]);
const variant = new URLSearchParams(location.search).get("variant") ?? "paid";
if (!allowed.has(variant)) {
	throw new Error("Unknown insight variant");
}
const node = {
	name: "owned-insight",
	url:
		variant === "authority"
			? "http://127.0.0.1:5611/a"
			: "http://127.0.0.1:5611",
	token:
		variant === "authority" ? "insight-node-a" : "model-insight-owned-token",
	userJwt: variant === "authority" ? "insight-user-a" : null,
};
useNodeStore.setState({
	nodes: [node],
	localNodes: [node],
	cloudNodes: [],
	defaultNode: node.name,
	tabOverrides: {},
	autoSelect: false,
	autoSelectedNode: null,
});
if (variant === "authority") {
	Object.defineProperty(window, "__modelInsightAuthorityStore", {
		value: useNodeStore,
	});
	const consumed: { url: string; body: string; status: number }[] = [];
	Object.defineProperty(window, "__modelInsightConsumed", { value: consumed });
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (...args: Parameters<typeof window.fetch>) => {
		const response = await originalFetch(...args);
		const url =
			typeof args[0] === "string"
				? args[0]
				: args[0] instanceof URL
					? args[0].href
					: args[0].url;
		if (url.includes("/api/models/insight?")) {
			const originalText = response.text.bind(response);
			response.text = async () => {
				const body = await originalText();
				// Actual SDK awaits this exact body. Its microtasks complete before
				// the frame ledger barrier; response bytes/headers are untouched.
				requestAnimationFrame(() =>
					consumed.push({ url, body, status: response.status })
				);
				return body;
			};
		}
		return response;
	};
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing insight fixture root");
}
createRoot(root).render(
	<main className="min-h-screen p-20">
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<button type="button">Choose model</button>}
			/>
			<DropdownMenuContent>
				<ModelMenuContent
					insightProvider="openrouter"
					models={[
						{
							id:
								variant === "authority"
									? "openrouter/shared"
									: `openrouter/${variant}`,
							name:
								variant === "authority" ? "Shared model" : `Model ${variant}`,
							group: null,
						},
					]}
					onSelect={() => undefined}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	</main>
);
