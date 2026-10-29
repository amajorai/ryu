import { I18nProvider } from "@ryu/i18n/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ContributedLibrarySection from "../../src/components/library/ContributedLibrarySection.tsx";
import { useSidebarSectionSources } from "../../src/hooks/useSidebarSectionSource.ts";
import type { PluginSidebarSection } from "../../src/lib/api/plugins.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import "../../src/index.css";
const view = new URLSearchParams(location.search).get("view") ?? "table";
const section: PluginSidebarSection = {
	id: "records",
	plugin: "com.example.records",
	title: "Project records",
	approved_grants: new URLSearchParams(location.search).has("denied")
		? []
		: ["ui:declarative-http"],
	http_policy: "core",
	spec: {
		view,
		itemTarget: "/chat?conversationId={{item.id}}",
		source: {
			http: { method: "GET", path: "/api/records" },
			items: "items",
			map: {
				id: "id",
				title: "title",
				subtitle: "subtitle",
				accessory: "status",
			},
		},
	},
};
queryClient.clear();
function Harness() {
	const [query, setQuery] = useState("");
	const [opened, setOpened] = useState("");
	const [source] = useSidebarSectionSources([section]);
	useEffect(() => {
		const handle = (event: Event) =>
			// SAFETY: The aliased local useTabsContext openTab publishes collection-open with its authored { path, options } detail; this observer only JSON-serializes that detail and imposes no DTO shape.
			setOpened(JSON.stringify((event as CustomEvent).detail));
		window.addEventListener("collection-open", handle);
		return () => window.removeEventListener("collection-open", handle);
	}, []);
	return (
		<main className="mx-auto max-w-4xl space-y-4 p-8">
			<h1 className="font-semibold text-2xl">Library</h1>
			<h2 className="text-lg">Project records</h2>
			<input
				aria-label="Search collection"
				className="w-full rounded-lg border bg-background p-2"
				onChange={(event) => setQuery(event.target.value)}
				value={query}
			/>
			<ContributedLibrarySection
				query={query}
				section={section}
				sourceData={source}
				view="grid"
			/>
			<output aria-label="Opened collection item">{opened}</output>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<I18nProvider>
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<Harness />
			</QueryClientProvider>
		</ThemeProvider>
	</I18nProvider>
);
