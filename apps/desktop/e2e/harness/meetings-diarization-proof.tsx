import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { MeetingsSettings } from "../../src/components/settings/MeetingsSettings.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import "../../src/index.css";

const realFetch = window.fetch.bind(window);
const preferences = new Map<string, string>();
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	const method = init?.method ?? "GET";
	const headers = { "content-type": "application/json" };

	if (url.pathname.startsWith("/api/preferences/")) {
		const key = decodeURIComponent(
			url.pathname.slice("/api/preferences/".length)
		);
		if (method === "PUT") {
			const body = z
				.object({ value: z.string().optional() })
				.parse(JSON.parse(String(init?.body ?? "{}")));
			if (isNativeText(body.value)) {
				preferences.set(key, body.value);
				if (key === "meeting-diarization-model") {
					document.body.dataset.savedDiarizationModel = body.value;
				}
			}
			return new Response(JSON.stringify({ ok: true }), {
				headers,
				status: 200,
			});
		}
		return new Response(
			JSON.stringify({ value: preferences.get(key) ?? null }),
			{
				headers,
				status: 200,
			}
		);
	}

	if (url.pathname === "/api/meetings/detection-config") {
		return new Response(
			JSON.stringify({ enabled: false, apps: ["zoom", "teams"] }),
			{
				headers,
				status: 200,
			}
		);
	}
	if (url.pathname === "/api/meetings/templates") {
		return new Response(
			JSON.stringify({ templates: [{ id: "default", name: "General" }] }),
			{ headers, status: 200 }
		);
	}
	if (url.pathname.startsWith("/api/")) {
		return new Response(JSON.stringify({ error: "not found" }), {
			headers,
			status: 404,
		});
	}
	return realFetch(input, init);
};

function ProofSurface() {
	return (
		<QueryClientProvider client={queryClient}>
			<EntitlementProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme="light"
					forcedTheme="light"
				>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<div className="mx-auto max-w-3xl">
							<MeetingsSettings />
						</div>
					</main>
				</ThemeProvider>
			</EntitlementProvider>
		</QueryClientProvider>
	);
}

createRoot(document.getElementById("root")!).render(<ProofSurface />);
