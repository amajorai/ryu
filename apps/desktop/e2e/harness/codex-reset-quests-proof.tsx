// Real Quests component and local sidecar; only the host transport is adapted.
import { markCompanionAppRoot } from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui.tsx";
import { createRoot } from "react-dom/client";
import { Quests } from "../../../../apps-store/quests/ui/src/Quests.tsx";
import type { RyuQuests } from "../../../../apps-store/quests/ui/src/ryu.d.ts";
import "../../../../apps-store/quests/ui/src/tailwind.css";

async function request<Body>(path = "", method = "GET", body?: Body) {
	const response = await fetch(`/api/quests${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? undefined : { body: JSON.stringify(body) }),
	});
	const data = await response.json();
	if (!response.ok || data.error) {
		throw new Error(data.error ?? `HTTP ${response.status}`);
	}
	return data;
}
const item = async <Body,>(path: string, body?: Body) =>
	(await request(path, "POST", body)).quest;
const quests: RyuQuests = {
	list: async () => (await request()).quests,
	create: async (body) => item("", body),
	update: async ({ id, input }) =>
		(await request(`/${id}`, "PUT", input)).quest,
	complete: async ({ id }) => item(`/${id}/complete`),
	dismiss: async ({ id }) => item(`/${id}/dismiss`),
	delete: async ({ id }) => {
		await request(`/${id}`, "DELETE");
	},
	capture: async (body) => item("/capture", body),
	pin: async ({ id, pinned }) => item(`/${id}/pin`, { pinned }),
	use: async ({ id, complete }) => item(`/${id}/use`, { complete }),
	judge: async ({ id }) => request(`/${id}/judge`, "POST", {}),
	acceptSuggestion: async ({ id }) => item(`/${id}/suggestion/accept`),
	dismissSuggestion: async ({ id }) => item(`/${id}/suggestion/dismiss`),
	scratchpad: async () => (await request("/scratchpad")).text,
	setScratchpad: async (body) => {
		await request("/scratchpad", "PUT", body);
	},
	openDetectionSettings: async () => {
		throw new Error("Host settings are unavailable in this transport proof");
	},
};
Object.assign(window, { ryu: { context: null, quests } });
const root = document.getElementById("ryu-plugin-root");
if (root) {
	markCompanionAppRoot(root);
	createRoot(root).render(
		<RyuAppShell>
			<Quests />
		</RyuAppShell>
	);
}
