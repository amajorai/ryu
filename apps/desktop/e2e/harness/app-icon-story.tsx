// Product components with every shipped app/plugin manifest; no catalog mocks.
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import type { CardDither } from "@ryu/marketplace/catalog/types";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

interface Manifest {
	icon?: string;
	iconDither?: CardDither;
	iconPadding?: string;
	iconUrl?: string;
	id: string;
	name: string;
	tagline?: string;
}
const source = import.meta.glob<Manifest>(
	[
		"../../../../apps-store/*/manifest.json",
		"../../../../plugins-store/plugins/*/manifest.json",
		"../../../../plugins-store/lsp/*/manifest.json",
		"../../../../plugins-store/external_plugins/*/manifest.json",
	],
	{ eager: true, import: "default" }
);
const entries = Object.entries(source).sort((a, b) =>
	a[1].name.localeCompare(b[1].name)
);

function Story() {
	const [theme, setTheme] = useState("light");
	const [kind, setKind] = useState("apps");
	const [selected, setSelected] = useState<Manifest | null>(null);
	const visible = entries.filter(([path]) =>
		kind === "apps"
			? path.includes("apps-store/")
			: path.includes("plugins-store/")
	);
	return (
		<main className={`${theme} min-h-screen bg-background text-foreground`}>
			<div className="mx-auto max-w-6xl p-5 sm:p-10">
				<header className="mb-8 flex flex-wrap items-center justify-between gap-4">
					<div>
						<h1 className="font-semibold text-2xl">Marketplace</h1>
						<p className="mt-1 text-muted-foreground text-sm">
							Apps and plugins for your workspace
						</p>
					</div>
					<Button
						onClick={() => setTheme(theme === "light" ? "dark" : "light")}
						variant="outline"
					>
						{theme === "light" ? "Dark appearance" : "Light appearance"}
					</Button>
				</header>
				<nav aria-label="Catalog" className="mb-6 flex gap-2">
					<Button
						onClick={() => {
							setKind("apps");
							setSelected(null);
						}}
						variant={kind === "apps" ? "default" : "ghost"}
					>
						Apps
					</Button>
					<Button
						onClick={() => {
							setKind("plugins");
							setSelected(null);
						}}
						variant={kind === "plugins" ? "default" : "ghost"}
					>
						Plugins
					</Button>
				</nav>
				{selected ? (
					<section
						aria-label="Selected app"
						className="mb-6 flex items-center gap-5 rounded-2xl bg-muted/30 p-6"
					>
						<AppIcon
							className="size-20"
							dither={selected.iconDither}
							iconId={selected.icon}
							iconPadding={selected.iconPadding}
							iconUrl={selected.iconUrl}
							name={selected.name}
							seedId={selected.id}
							size={40}
							variant="hero"
						/>
						<div>
							<h2 className="font-semibold text-xl">{selected.name}</h2>
							<p className="text-muted-foreground text-sm">
								{selected.tagline}
							</p>
						</div>
					</section>
				) : null}
				<section
					aria-label={kind === "apps" ? "Apps" : "Plugins"}
					className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3"
				>
					{visible.map(([, m]) => (
						<div data-package={m.id} data-testid="tile" key={m.id}>
							<StoreCatalogCard
								description={m.tagline}
								dither={m.iconDither}
								iconId={m.icon}
								iconPadding={m.iconPadding}
								iconUrl={m.iconUrl}
								name={m.name}
								onClick={() => setSelected(m)}
								seedId={m.id}
							/>
						</div>
					))}
				</section>
				<section
					aria-label="Artwork closeups"
					className="mt-10 rounded-2xl bg-card p-6"
				>
					<h2 className="mb-6 font-medium text-lg">Icon artwork</h2>
					<div className="grid grid-cols-2 gap-6 sm:grid-cols-5 lg:grid-cols-5">
						{entries
							.filter(([, m]) =>
								[
									"@ryu/browser",
									"@ryu/calendar",
									"@ryu/mail",
									"@ryu/canvas",
									"@ryu/sites",
									"@ryu/voice",
									"@ryu/dictation",
									"@ryu/whiteboard",
									"@ryu/agent-status",
									"@ryu/tuition",
								].includes(m.id)
							)
							.map(([, m]) => (
								<div className="text-center" key={m.id}>
									<AppIcon
										className="mx-auto size-32"
										name={m.name}
										seedId={m.id}
										size={64}
									/>
									<p className="mt-3 text-sm">{m.name}</p>
								</div>
							))}
					</div>
				</section>
				<section
					aria-label="Icon sizes"
					className="mt-10 flex items-end gap-6 border-t pt-6"
				>
					{[20, 40, 80, 128].map((size) => (
						<div key={size}>
							<AppIcon
								className={
									size === 20
										? "size-5"
										: size === 40
											? "size-10"
											: size === 80
												? "size-20"
												: "size-32"
								}
								dither={{ from: 351 }}
								iconId="browser"
								name="Browser"
								seedId="@ryu/browser"
								size={size / 2}
							/>
							<p className="mt-2 text-muted-foreground text-xs">{size}px</p>
						</div>
					))}
				</section>
			</div>
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
