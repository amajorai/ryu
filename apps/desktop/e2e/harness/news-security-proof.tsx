// Render the shipped Wire entry against an isolated, real News sidecar.
// This transport adapter does not mock responses or prove Core's ext-proxy.
import { isNativeObjectReceiver } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { RyuWireBridge } from "../../../../apps-store/news/ui/src/ryu.d.ts";

const news: RyuWireBridge = {
	async request({ method = "GET", path, body }) {
		if (!path.startsWith("/") || path.startsWith("//")) {
			throw new Error("Invalid News path");
		}
		const serializedBody =
			body === undefined ? undefined : JSON.stringify(body);
		if (method === "GET" && serializedBody !== undefined) {
			throw new TypeError("News GET requests cannot include a body");
		}
		const requestInit: RequestInit = {
			method,
			headers: { "Content-Type": "application/json" },
		};
		if (method !== "GET") {
			requestInit.body = serializedBody;
		}
		const response = await fetch(`/api/news${path}`, requestInit);
		const result = await response.json();
		if (!response.ok) {
			const message =
				result && isNativeObjectReceiver(result) && "error" in result
					? String(result.error)
					: `News request failed (${response.status})`;
			throw new Error(message);
		}
		return result;
	},
};

const tab = new URL(window.location.href).searchParams.get("tab") ?? "sources";
Object.assign(window, { ryu: { context: { tab }, news } });
await import("../../../../apps-store/news/ui/src/main.tsx");
