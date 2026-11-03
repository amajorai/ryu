import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RideCity, RideTrip } from "./rides-model.ts";

// This file owns its DOM (never the shared rides-test-dom module, whose
// one-time flag would then belong to whichever file loaded it first).
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { I18nProvider } = await import("@ryu/i18n/react");
const { RidesList } = await import("./rides-list.tsx");
const { buildRides, chipText, tripHeadline, tripWord } = await import(
	"./rides-model.ts"
);

/*
 * A trip's status word is interpolated into whole sentences ("{title},
 * {word}. Show the trip"), so it is translated before it goes in: a German
 * reader never hears "Release notes, Your turn. Fahrt anzeigen".
 */

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");

const DE: Record<string, string> = {
	"{tripTitle}, {stage}. Show the trip": "{tripTitle}, {stage}. Fahrt anzeigen",
	"Run failed": "Lauf fehlgeschlagen",
	"Run interrupted": "Lauf unterbrochen",
	"Up next": "Als Nächstes",
	"Your turn": "Du bist dran",
	"Nothing has been sent yet": "Es wurde noch nichts gesendet",
	"The run failed. Send a message to try again.":
		"Der Lauf ist fehlgeschlagen. Sende eine Nachricht, um es erneut zu versuchen.",
};

const de: LiteralMessage = (source: string, values?: MessageValuesInput) =>
	formatMessage(DE[source] ?? source, values ?? {}, "de");

function thread(id: string): InterfaceThread {
	return {
		agentIds: ["agent-ada"],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: "Release notes",
		updatedAt: new Date().toISOString(),
		id,
	};
}

const SNAPSHOT = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	asks: [],
	events: [],
	threads: [thread("thread-1")],
} as unknown as InterfaceSnapshot;

/** The one trip, forced to `stage` so each word can be checked. */
function cityAt(stage: RideTrip["stage"], patch: Partial<RideTrip> = {}) {
	const city = buildRides(SNAPSHOT);
	return {
		...city,
		trips: city.trips.map((trip) => ({ ...trip, stage, ...patch })),
	} satisfies RideCity;
}
const tripAt = (stage: RideTrip["stage"], patch: Partial<RideTrip> = {}) => {
	const [trip] = cityAt(stage, patch).trips;
	if (!trip) {
		throw new Error("the snapshot has one trip");
	}
	return trip;
};

describe("tripWord", () => {
	test("returns the translated word when given a translator", () => {
		expect(tripWord(tripAt("arrived"), undefined, de)).toBe("Du bist dran");
		expect(tripWord(tripAt("cancelled"), undefined, de)).toBe(
			"Lauf fehlgeschlagen"
		);
		expect(
			tripWord(
				tripAt("cancelled", {
					thread: { ...thread("thread-1"), runState: "interrupted" },
				} as Partial<RideTrip>),
				undefined,
				de
			)
		).toBe("Lauf unterbrochen");
		expect(tripWord(tripAt("enroute", { carless: true }), undefined, de)).toBe(
			"Als Nächstes"
		);
	});

	test("English reads as before", () => {
		expect(tripWord(tripAt("arrived"))).toBe("Your turn");
		expect(tripWord(tripAt("cancelled"))).toBe("Run failed");
		expect(chipText(tripAt("enroute", { carless: true })).lead).toBe("Up next");
	});

	test("the open trip's status uses the same translated word", () => {
		expect(tripHeadline(tripAt("arrived"), de).status).toBe("Du bist dran");
	});

	test("the open trip's sentence is translated too", () => {
		expect(tripHeadline(tripAt("cancelled"), de).detail).toBe(
			"Der Lauf ist fehlgeschlagen. Sende eine Nachricht, um es erneut zu versuchen."
		);
		const idle = tripHeadline(tripAt("unstarted"), de);
		expect(idle.detail).toBe("Es wurde noch nichts gesendet");
	});
});

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function pinLabel(locale: string): Promise<string | null> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<RidesList
					onOpenTrip={() => undefined}
					onPickDriver={() => undefined}
					onSelectTrip={() => undefined}
					rides={cityAt("arrived")}
					selectedTripId={null}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return (
		container
			.querySelector('[data-testid="rides-pin"]')
			?.getAttribute("aria-label") ?? null
	);
}

describe("the rides list pin name", () => {
	test("is the catalog sentence with the translated word under de", async () => {
		expect(await pinLabel("de")).toBe(
			"Release notes, Du bist dran. Fahrt anzeigen"
		);
	});

	test("reads in English under en", async () => {
		expect(await pinLabel("en")).toBe(
			"Release notes, Your turn. Show the trip"
		);
	});
});
