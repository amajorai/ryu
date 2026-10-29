import { I18nProvider } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { VersionsPanel } from "../../../../packages/marketplace/src/catalog/detail/detail-panels.tsx";
import { useActiveNode } from "../../src/hooks/useActiveNode.ts";
import { useAppsCatalog } from "../../src/hooks/useAppsCatalog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const nodes = [
	{
		name: "Alpha",
		url: `${location.origin}/__nodes/alpha`,
		token: "alpha-node-token",
		userJwt: "alpha-delegation",
	},
	{
		name: "Beta",
		url: `${location.origin}/__nodes/beta`,
		token: "beta-node-token",
		userJwt: "beta-delegation",
	},
];
useNodeStore.setState({
	nodes,
	defaultNode: "Alpha",
	autoSelect: false,
	autoSelectedNode: null,
	tabOverrides: {},
});
const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});

function VersionInstallCaller() {
	const catalog = useAppsCatalog();
	const node = useActiveNode();
	// Core's rich catalog detail carries history; the shared panel consumes the
	// same wire field as the Apps section. No versions or install result are
	// fabricated by this caller: all installed state comes from the hook's reads.
	const detail = z
		.object({
			versions: z
				.array(
					z.object({
						version: z.string(),
						downloads: z.number().nullable().optional(),
						installable: z.boolean().optional(),
						name: z.string().nullable().optional(),
						notes: z.string().nullable().optional(),
						prerelease: z.boolean().optional(),
						publishedAt: z.string().nullable().optional(),
						stability: z.string().nullable().optional(),
						stabilityKnown: z.boolean().optional(),
						tagOnly: z.boolean().optional(),
						url: z.string().nullable().optional(),
					})
				)
				.nullable()
				.optional(),
		})
		.nullable()
		.parse(catalog.detail);
	return (
		<main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-5 bg-background p-8 text-foreground">
			<h1 className="font-semibold text-xl">
				Marketplace version installation
			</h1>
			<nav aria-label="Selected node" className="flex gap-3">
				{nodes.map((target) => (
					<Button
						key={target.name}
						onClick={() => useNodeStore.setState({ defaultNode: target.name })}
						variant="outline"
					>
						Switch to {target.name}
					</Button>
				))}
			</nav>
			<output aria-label="Active target">{node.name}</output>
			<nav aria-label="Catalog listings" className="flex gap-3">
				{catalog.items.map((item) => (
					<Button
						key={item.entry.id}
						onClick={() => catalog.select(item.entry.id)}
						variant="outline"
					>
						{item.entry.name}
					</Button>
				))}
			</nav>
			{catalog.error ? <p role="alert">{catalog.error}</p> : null}
			{catalog.selectedItem ? (
				<section
					aria-label="Selected listing"
					className="flex flex-col gap-3 rounded-lg border p-5"
				>
					<h2 className="font-semibold">{catalog.selectedItem.entry.name}</h2>
					<output aria-label="Installed version">
						{catalog.selectedItem.installedVersion ?? "Not installed"}
					</output>
					<output aria-label="Installed state">
						{String(catalog.selectedItem.installed)}
					</output>
					{detail?.versions ? (
						<VersionsPanel
							installVersion={(version) =>
								catalog.installVersion(
									catalog.selectedItem?.entry.id ?? "",
									version
								)
							}
							key={node.url}
							versions={detail.versions}
						/>
					) : null}
				</section>
			) : null}
		</main>
	);
}

document.documentElement.classList.add("dark");
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing Marketplace version install root");
}
createRoot(root).render(
	<QueryClientProvider client={client}>
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark">
				<VersionInstallCaller />
			</ThemeProvider>
		</I18nProvider>
	</QueryClientProvider>
);
