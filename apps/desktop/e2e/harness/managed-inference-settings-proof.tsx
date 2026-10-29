import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ManagedInferenceSettings } from "../../src/components/settings/NetworkSettings.tsx";
import "../../src/index.css";

const search = new URL(window.location.href).searchParams;
const storageKey = "managed-inference-settings-proof.preferences";
const seed =
	search.get("configured") === "true"
		? {
				"managed-gateway-token": "rgw_existing_token",
				"managed-gateway-url": "https://fleet.example.test",
			}
		: {};
const stored = localStorage.getItem(storageKey);
const preferences = z
	.record(z.string(), z.string())
	.parse(stored ? JSON.parse(stored) : seed);
localStorage.setItem(storageKey, JSON.stringify(preferences));
interface ManagedInferenceCapturedState {
	failPreferenceKey: string | null;
	flagEnabled: boolean;
	writes: Array<{ key: string; value: string }>;
}

const state: ManagedInferenceCapturedState = {
	failPreferenceKey: search.get("failKey"),
	flagEnabled: search.get("flag") !== "false",
	writes: [],
};

declare global {
	interface Window {
		__managedInferenceProof: typeof state;
	}
}

window.__managedInferenceProof = state;

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	const prefix = "/api/preferences/";
	if (url.pathname.startsWith(prefix)) {
		const key = decodeURIComponent(url.pathname.slice(prefix.length));
		if (init?.method === "PUT") {
			const body = z
				.object({ value: z.string().optional() })
				.parse(JSON.parse(String(init.body ?? "{}")));
			state.writes.push({ key, value: body.value ?? "" });
			if (state.failPreferenceKey === key) {
				return Response.json(
					{ error: "Managed preference write failed" },
					{ status: 500 }
				);
			}
			preferences[key] = body.value ?? "";
			localStorage.setItem(storageKey, JSON.stringify(preferences));
			return Response.json({ ok: true });
		}
		if (key in preferences) {
			return Response.json({ key, value: preferences[key] });
		}
		return Response.json({ error: "preference_not_set" }, { status: 404 });
	}
	return realFetch(input, init);
};

createRoot(document.getElementById("root")!).render(
	<main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
		<h1 className="font-semibold text-2xl">Managed inference settings</h1>
		<ManagedInferenceSettings />
		<Toaster position="bottom-right" />
	</main>
);
