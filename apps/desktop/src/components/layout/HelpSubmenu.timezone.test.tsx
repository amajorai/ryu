import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

/**
 * The account menu's Help > "What's new?" list reads `/api/updates/recent`, whose
 * `date` values are the marketing site's calendar days (`2026-10-01`, never an
 * instant). `new Date("2026-10-01")` is UTC midnight, so formatting it in a display
 * zone west of UTC shows the previous day. `formatDate` already prints a bare
 * `YYYY-MM-DD` as written, but only when it receives the string: each case below
 * renders the real submenu with the real feed shape and asserts the day on screen.
 * A probe first asserts the zone is one where UTC midnight is a different local day,
 * so a runtime that ignored the zone would fail instead of passing vacuously.
 */
const machineZone = process.env.TZ;

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Flatten the menu primitives so every item is plain markup. The date text under
// test is produced by HelpSubmenu and the real `formatDate`, not by the menu.
function Pass({ children }: { children?: ReactNode }) {
	return <div>{children}</div>;
}
mock.module("@ryu/ui/components/dropdown-menu.tsx", () => ({
	DropdownMenuGroup: Pass,
	DropdownMenuItem: Pass,
	DropdownMenuLabel: Pass,
	DropdownMenuSeparator: () => null,
	DropdownMenuSub: Pass,
	DropdownMenuSubContent: Pass,
	DropdownMenuSubTrigger: Pass,
}));

// The label animator needs layout and the Web Animations API, which happy-dom lacks.
// It only displays the `text` it is given, so a passthrough keeps the string under test.
mock.module("./overflow-tooltip.tsx", () => ({
	OverflowTooltip: ({ text }: { text: string }) => (
		<span data-label="">{text}</span>
	),
}));

const { createRoot } = await import("react-dom/client");
const { HelpSubmenu } = await import("./HelpSubmenu.tsx");
const { resetTimezone, setTimezonePreference } = await import(
	"@/src/lib/timezone.ts"
);

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	globalThis.fetch = realFetch;
	resetTimezone();
});

afterAll(() => {
	if (machineZone === undefined) {
		Reflect.deleteProperty(process.env, "TZ");
	} else {
		process.env.TZ = machineZone;
	}
});

interface FeedItem {
	date: string;
	id: string;
	kind: "blog" | "changelog";
	slug: string;
	tag?: string;
	title: string;
	type?: string;
	version?: string;
}

function changelog(date: string, version: string): FeedItem {
	return {
		date,
		id: `changelog-${version}`,
		kind: "changelog",
		slug: `v${version}`,
		title: `Release ${version}`,
		type: "feature",
		version,
	};
}

function blog(date: string, slug: string): FeedItem {
	return {
		date,
		id: `blog-${slug}`,
		kind: "blog",
		slug,
		title: `Post ${slug}`,
	};
}

async function renderWhatsNew(items: FeedItem[]): Promise<string[]> {
	globalThis.fetch = (async () =>
		Response.json({ items })) as unknown as typeof fetch;
	const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<HelpSubmenu />
			</QueryClientProvider>
		);
	});
	for (let tick = 0; tick < 50; tick += 1) {
		if (container.textContent?.includes(items[0]?.title ?? "")) {
			break;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
	// The second line of each row is the meta line ("Changelog · v1.2.3 · Oct 1, 2026").
	return [...container.querySelectorAll("[data-label]")]
		.map((el) => el.textContent ?? "")
		.filter((text) => text.startsWith("Changelog") || text.startsWith("Blog"));
}

/** Zones west of UTC show the previous day for UTC midnight; UTC and east do not. */
const ZONES = [
	{ zone: "Pacific/Honolulu", previousDay: true },
	{ zone: "America/Los_Angeles", previousDay: true },
	{ zone: "America/New_York", previousDay: true },
	{ zone: "UTC", previousDay: false },
	{ zone: "Asia/Tokyo", previousDay: false },
	{ zone: "Pacific/Kiritimati", previousDay: false },
] as const;

/** Six release days on boundaries: month, year and daylight-saving edges. */
const BATCHES = [
	{
		items: [
			changelog("2026-10-01", "1.4.0"),
			blog("2026-03-15", "spring-tour"),
			changelog("2026-01-01", "1.3.0"),
		],
		meta: [
			"Changelog · v1.4.0 · Oct 1, 2026",
			"Blog · Mar 15, 2026",
			"Changelog · v1.3.0 · Jan 1, 2026",
		],
	},
	{
		items: [
			changelog("2026-12-31", "1.5.0"),
			blog("2026-03-08", "clocks-forward"),
			changelog("2026-03-01", "1.2.0"),
		],
		meta: [
			"Changelog · v1.5.0 · Dec 31, 2026",
			"Blog · Mar 8, 2026",
			"Changelog · v1.2.0 · Mar 1, 2026",
		],
	},
] as const;

for (const { zone, previousDay } of ZONES) {
	for (const [index, batch] of BATCHES.entries()) {
		test(`${zone}: What's new shows each release on its written day (set ${index + 1})`, async () => {
			const probe = new Intl.DateTimeFormat("en-US", {
				day: "numeric",
				timeZone: zone,
			}).format(new Date("2026-03-15"));
			expect(probe).toBe(previousDay ? "14" : "15");
			setTimezonePreference(zone);

			expect(await renderWhatsNew([...batch.items])).toEqual([...batch.meta]);
		});
	}
}

test("the machine zone decides when the display zone follows the system", async () => {
	process.env.TZ = "America/Los_Angeles";
	expect(
		new Date("2026-10-01").toLocaleDateString("en-US", { day: "numeric" })
	).toBe("30");
	resetTimezone();

	expect(
		await renderWhatsNew([
			changelog("2026-10-01", "1.4.0"),
			blog("2026-03-15", "spring-tour"),
			changelog("2026-01-01", "1.3.0"),
		])
	).toEqual([...BATCHES[0].meta]);
});

test("a feed timestamp is an instant and still follows the display zone", async () => {
	// 09:00 at UTC-8 is 17:00 UTC on 1 April: still April 1 in Los Angeles and UTC,
	// and 07:00 on April 2 at UTC+14.
	const feed = [
		changelog("2026-04-01T09:00:00-08:00", "1.4.0"),
		blog("2026-04-01T09:00:00-08:00", "instant"),
	];
	setTimezonePreference("America/Los_Angeles");
	expect(await renderWhatsNew(feed)).toEqual([
		"Changelog · v1.4.0 · Apr 1, 2026",
		"Blog · Apr 1, 2026",
	]);

	await act(async () => root.unmount());
	root = createRoot(container);
	setTimezonePreference("Pacific/Kiritimati");
	expect(await renderWhatsNew(feed)).toEqual([
		"Changelog · v1.4.0 · Apr 2, 2026",
		"Blog · Apr 2, 2026",
	]);
});
