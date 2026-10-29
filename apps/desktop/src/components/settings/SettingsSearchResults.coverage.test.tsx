import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	click,
	flush,
	maybeButton,
	normalized,
	registerDomWithNativeNetworking,
} from "./unswept-b.test-support.ts";

// Coverage for `SettingsSearchResults`, the result list both settings dialogs
// show in place of their sidebar nav while a query is typed. It is mounted the
// way the dialogs mount it (inside the shipping sidebar provider and an app
// surface) and searched against the real shipping settings index. The effect
// under test is what a person sees and what the host receives: which rows are
// offered, under which "where it lives" heading, whether a row that lives in the
// other dialog says so, which rows a non-desktop surface withholds, the empty
// state, and the exact index entry handed to the host when a row is chosen.
registerDomWithNativeNetworking();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SidebarProvider } = await import("@ryu/ui/components/sidebar.tsx");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
const { SettingsSearchResults } = await import("./SettingsSearchResults.tsx");

type Root = ReturnType<typeof createRoot>;
type Surface = "desktop" | "web" | "mobile";
type Dialog = "app" | "gateway";
type Entry = (typeof SETTINGS_ENTRIES)[number];

let root: Root | null = null;
let container: HTMLDivElement;
let selected: Entry[] = [];

beforeEach(() => {
	selected = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	const mounted = root;
	root = null;
	await act(async () => mounted?.unmount());
	document.body.replaceChildren();
});

async function render(options: {
	currentDialog: Dialog;
	query: string;
	showEmptyState?: boolean;
	surface?: Surface;
}) {
	await act(async () =>
		root?.render(
			<AppSurfaceProvider surface={options.surface ?? "desktop"}>
				<SidebarProvider>
					<SettingsSearchResults
						currentDialog={options.currentDialog}
						onSelect={(entry) => selected.push(entry)}
						query={options.query}
						showEmptyState={options.showEmptyState}
					/>
				</SidebarProvider>
			</AppSurfaceProvider>
		)
	);
	await flush(2);
}

/** Each result group as `heading → [row label (row group caption)]`. */
function groups(): Array<{ heading: string; rows: string[] }> {
	return [
		...container.querySelectorAll<HTMLElement>('[data-slot="sidebar-group"]'),
	]
		.filter((group) => group.querySelector('[data-slot="sidebar-menu"]'))
		.map((group) => ({
			heading: normalized(
				group.querySelector('[data-slot="sidebar-group-label"]')
			),
			rows: [
				...group.querySelectorAll<HTMLElement>(
					'[data-slot="sidebar-menu-button"]'
				),
			].map((row) => {
				const [label, caption] = [
					...row.querySelectorAll<HTMLElement>("span > span"),
				].map((part) => normalized(part));
				return caption ? `${label} (${caption})` : (label ?? "");
			}),
		}));
}

/** The menu button whose first line is exactly `label`. */
function result(label: string): HTMLButtonElement {
	const found = [
		...container.querySelectorAll<HTMLButtonElement>(
			'[data-slot="sidebar-menu-button"]'
		),
	].find(
		(row) => normalized(row.querySelector("span > span")) === label.trim()
	);
	if (!found) {
		throw new Error(`Missing result ${label}: ${normalized(container)}`);
	}
	return found;
}

function indexed(id: string): Entry {
	const entry = SETTINGS_ENTRIES.find((candidate) => candidate.id === id);
	if (!entry) {
		throw new Error(`The settings index lost ${id}`);
	}
	return entry;
}

test("results are grouped under the section they live in, rows in the other dialog say so, and choosing one hands the host that exact index entry", async () => {
	await render({ currentDialog: "app", query: "folder" });

	expect(groups()).toEqual([
		{
			heading: "General",
			rows: [
				"Projectless task folder (On startup)",
				"Default file open destination (Files)",
			],
		},
		{ heading: "Appearance", rows: ["Sticky folders (File tree)"] },
		{
			heading: "Developer",
			rows: ["Wipe this data folder at midnight (Daily data reset)"],
		},
		{
			heading: "Storage · Node",
			rows: [
				"Current location (Data folder)",
				"Default location (Data folder)",
				"Size (Data folder)",
			],
		},
		{ heading: "Encryption · Node", rows: ["Location (Data folder)"] },
	]);

	// A same-dialog row and a cross-dialog row each hand over their own entry,
	// unchanged, so the host can navigate (or switch dialogs) and reveal it.
	await click(result("Sticky folders"));
	await click(result("Location"));
	expect(selected).toHaveLength(2);
	expect(selected[0]).toBe(indexed("appearance.file-tree.sticky-folders"));
	expect(selected[1]).toBe(indexed("gw.encryption.data-folder.location"));
	expect(selected[1]).toMatchObject({
		dialog: "gateway",
		group: "Data folder",
		label: "Location",
		section: "encryption",
	});
});

test("from the Gateway dialog the suffix flips: app-dialog rows are marked App and node rows are not", async () => {
	await render({ currentDialog: "gateway", query: "folder" });
	expect(groups().map((group) => group.heading)).toEqual([
		"General · App",
		"Appearance · App",
		"Developer · App",
		"Storage",
		"Encryption",
	]);

	// Re-rendering the same mounted list for the other dialog relabels it.
	await render({ currentDialog: "app", query: "folder" });
	expect(groups().map((group) => group.heading)).toEqual([
		"General",
		"Appearance",
		"Developer",
		"Storage · Node",
		"Encryption · Node",
	]);
});

test("a surface without the native shell never offers desktop-only rows, and the trimmed query is searched again as it changes", async () => {
	await render({ currentDialog: "app", query: "folder", surface: "web" });
	const headings = groups().map((group) => group.heading);
	expect(headings).not.toContain("General");
	expect(maybeButton("Projectless task folder On startup", container)).toBe(
		null
	);
	expect(groups()[0]).toEqual({
		heading: "Appearance",
		rows: ["Sticky folders (File tree)"],
	});
	expect(groups().flatMap((group) => group.rows)).toHaveLength(6);

	// A query that only matches a desktop-only row is an empty result on web…
	await render({
		currentDialog: "app",
		query: "  Projectless  ",
		surface: "mobile",
	});
	expect(groups()).toEqual([]);
	expect(normalized(container)).toBe("No setting matches “Projectless”.");

	// …and the same mounted list on the desktop surface offers it.
	await render({ currentDialog: "app", query: "  Projectless  " });
	expect(groups()).toEqual([
		{ heading: "General", rows: ["Projectless task folder (On startup)"] },
	]);
	await click(result("Projectless task folder"));
	expect(selected).toEqual([
		indexed("general.on-startup.projectless-task-folder"),
	]);
});

test("no match prints the trimmed query, and a host that already lists matching sections suppresses that message entirely", async () => {
	await render({ currentDialog: "app", query: "   zzqxv  " });
	expect(normalized(container)).toBe("No setting matches “zzqxv”.");
	expect(container.querySelectorAll("button")).toHaveLength(0);

	await render({ currentDialog: "app", query: "zzqxv", showEmptyState: false });
	// Nothing inside the sidebar: no group, no message, no stray markup.
	expect(
		container.querySelector('[data-slot="sidebar-wrapper"]')?.innerHTML
	).toBe("");

	// Suppression only applies to the empty state; real hits still render.
	await render({
		currentDialog: "app",
		query: "Theme mode",
		showEmptyState: false,
	});
	expect(groups()).toEqual([
		{
			heading: "Appearance",
			rows: ["Theme mode (Diff viewer)", "Color theme (Theme)"],
		},
	]);
});

test("every result is a native button a keyboard user can reach and activate, and only the activated row is reported", async () => {
	await render({ currentDialog: "app", query: "analytics" });
	const rows = [
		...container.querySelectorAll<HTMLButtonElement>(
			'[data-slot="sidebar-menu-button"]'
		),
	];
	expect(rows.map((row) => row.tagName)).toEqual(["BUTTON", "BUTTON"]);
	expect(rows.every((row) => row.type !== "submit" || !row.form)).toBe(true);
	expect(rows.every((row) => row.tabIndex >= 0 && !row.disabled)).toBe(true);
	await act(async () => rows[1]?.focus());
	expect(document.activeElement).toBe(rows[1] as HTMLButtonElement);
	await click(result("What we send"));
	expect(selected.map((entry) => entry.label)).toEqual(["What we send"]);
	expect(selected[0]?.dialog).toBe("gateway");
});
