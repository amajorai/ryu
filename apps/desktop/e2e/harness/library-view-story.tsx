import type { SidebarSectionSpec, SourceItem } from "@ryu/app-host/views";
import { createRoot } from "react-dom/client";
import LibraryView from "../../src/components/views/LibraryView.tsx";
import "../../src/index.css";

const rows: SourceItem[] = [
	{
		item: {
			id: "one",
			title: "Design brief",
			subtitle: "Ready for review",
			accessory: "Today",
			badges: [{ label: "Ready" }],
		},
		raw: { id: "one", date: "2026-08-19" },
	},
	{
		item: {
			id: "two",
			title: "Release notes",
			subtitle: "Draft copy",
			accessory: "Yesterday",
			badges: [{ label: "Draft" }],
		},
		raw: { id: "two", date: "2026-08-18" },
	},
	{
		item: {
			id: "three",
			title: "Launch checklist",
			subtitle: "Final pass",
			accessory: "Tomorrow",
			badges: [{ label: "Ready" }],
		},
		raw: { id: "three", date: "2026-08-20" },
	},
];

const section = (view: string) => ({
	icon: "package-01",
	id: "library-proof",
	plugin: "com.ryu.proof",
	spec: {
		itemTarget: "/library/{{item.id}}",
		view,
	} satisfies SidebarSectionSpec,
	title: "Project library",
});

function Story() {
	return (
		<main className="mx-auto max-w-4xl space-y-8 p-8">
			<header>
				<h1 className="font-semibold text-2xl">Library view proof</h1>
				<p className="text-muted-foreground">Host-owned declarative layouts</p>
			</header>
			<section aria-labelledby="board-heading">
				<h2 className="mb-3 font-medium" id="board-heading">
					Board
				</h2>
				<LibraryView
					error={null}
					isLoading={false}
					onOpen={() => undefined}
					rows={rows}
					section={section("kanban")}
					view="grid"
				/>
			</section>
			<section aria-labelledby="table-heading">
				<h2 className="mb-3 font-medium" id="table-heading">
					Data table
				</h2>
				<LibraryView
					error={null}
					isLoading={false}
					onOpen={() => undefined}
					rows={rows}
					section={section("database")}
					view="table"
				/>
			</section>
			<section aria-labelledby="feed-heading">
				<h2 className="mb-3 font-medium" id="feed-heading">
					Feed
				</h2>
				<LibraryView
					error={null}
					isLoading={false}
					onOpen={() => undefined}
					rows={rows}
					section={section("feed")}
					view="list"
				/>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
