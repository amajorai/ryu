// Interface model words under a German UI. The DOM localizer skips
// `[data-ryu-i18n=off]` regions and cannot match a word once it is spliced into
// an aria-label or a sentence, so the synthetic names the models make
// ("Unassigned", "Old Town", "Personal", run outcomes, status sentences) must
// already be translated when the model returns them.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	InterfaceEvent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { translate: tr } = await import("@ryu/i18n/lite");
const { MessengerInterface } = await import("./messenger-interface.tsx");
const { projectMessengerEntries } = await import("./messenger-model.ts");
const { buildMomentsFlows } = await import("./moments-model.ts");
const { jobCompanies } = await import("./jobs-model-core.ts");
const { buildTown } = await import("./town-model-build.ts");
const { buildStatusPage } = await import("./status-model.ts");
const { bracketedRunOutcome, runOutcomeAgo, scheduledRunOutcome } =
	await import("./wiki-model-words.ts");
const { buildBoards, flightAccessibleName } = await import(
	"./departures-model.ts"
);
const { buildFlowLayout } = await import("./flow-model-layout.ts");
const { forumCategories } = await import("./forum-model.ts");
const { buildQuizBoard } = await import("./quiz-model.ts");
const { collectionBooks, progressLabel } = await import("./library-model.ts");
const { mailStatusChip } = await import("./mail-model.ts");
const { visitVillagerLabel } = await import("./world-2d-model.ts");

const DE: Record<string, string> = {
	"Conversations without an agent or team":
		"Unterhaltungen ohne Agent oder Team",
	Unassigned: "Nicht zugewiesen",
	"Unassigned threads": "Nicht zugewiesene Unterhaltungen",
	"Review what needs you": "Prüfen, was dich braucht",
	Personal: "Persönlich",
	"Old Town": "Altstadt",
	"The scheduled run did not finish, and it has not succeeded since.":
		"Der geplante Lauf wurde nicht beendet und ist seitdem nicht gelungen.",
	"(scheduled run, {outcome, select, scheduled {scheduled} failed {failed} succeeded {succeeded} other {ran}})":
		"(geplanter Lauf, {outcome, select, scheduled {geplant} failed {fehlgeschlagen} succeeded {erfolgreich} other {gelaufen}})",
	"({outcome, select, scheduled {scheduled} failed {failed} succeeded {succeeded} other {ran}})":
		"({outcome, select, scheduled {geplant} failed {fehlgeschlagen} succeeded {erfolgreich} other {gelaufen}})",
	"{outcome, select, scheduled {scheduled} failed {failed} succeeded {succeeded} other {ran}} {ago}":
		"{outcome, select, scheduled {geplant} failed {fehlgeschlagen} succeeded {erfolgreich} other {gelaufen}} {ago}",
	"Run failed": "Lauf fehlgeschlagen",
	"Your turn": "Du bist dran",
	Uncategorized: "Ohne Kategorie",
	"No chapters yet": "Noch keine Kapitel",
	"Visit {name}{status, select, attention { (needs attention)} yourTurn { (your turn)} working { (working)} other {}}":
		"{name} besuchen{status, select, attention { (braucht Aufmerksamkeit)} yourTurn { (du bist dran)} working { (arbeitet)} other {}}",
};

/** English catalog words that must not survive in German output. */
const ENGLISH = [
	"Unassigned",
	"Review what needs you",
	"Personal",
	"Old Town",
	"scheduled run did not finish",
	"Run failed",
	"Your turn",
	"Uncategorized",
	"No chapters yet",
	"needs attention",
	"failed",
];

function englishIn(text: string): string[] {
	return ENGLISH.filter((word) => text.includes(word));
}

const NOW = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: ago(60),
		...input,
	};
}

const FAILED_RUN: InterfaceEvent = {
	agentId: "agent-ada",
	end: ago(25),
	id: "run-1",
	kind: "past",
	label: "Every day",
	outcome: "failure",
	start: ago(30),
	title: "Backup",
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	events: [FAILED_RUN],
	groups: [],
	threads: [
		thread({ id: "orphan", lastMessageRole: "user" }),
		thread({ agentIds: ["agent-ada"], id: "failing", runState: "failed" }),
	],
	version: 1,
};

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

async function mountGerman(node: React.ReactNode = null): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="de" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

const port = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

describe("interface model words in German", () => {
	test("messenger's Unassigned row is translated inside the off region", async () => {
		const container = await mountGerman(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const offText = [...container.querySelectorAll("[data-ryu-i18n=off]")]
			.map((element) => element.textContent ?? "")
			.join("\n");
		expect(offText).toContain("Nicht zugewiesen");
		expect(englishIn(offText)).toEqual([]);
		const orphans = projectMessengerEntries(SNAPSHOT).find(
			(entry) => entry.kind === "other"
		);
		expect(orphans?.description).toBe("Unterhaltungen ohne Agent oder Team");
	});

	test("moments, jobs and town name their synthetic groups in German", async () => {
		await mountGerman();
		const flowNames = buildMomentsFlows(SNAPSHOT).map((flow) => flow.name);
		expect(flowNames).toContain("Prüfen, was dich braucht");
		expect(flowNames).toContain("Nicht zugewiesene Unterhaltungen");
		expect(jobCompanies(SNAPSHOT)[0]?.name).toBe("Persönlich");
		const town = buildTown(SNAPSHOT, NOW);
		expect(town.districts.map((district) => district.name)).toContain(
			"Altstadt"
		);
		expect(
			englishIn(town.petitions.map((p) => p.districtName).join("\n"))
		).toEqual([]);
	});

	test("status and wiki run outcomes are whole German sentences", async () => {
		await mountGerman();
		const page = buildStatusPage(SNAPSHOT, NOW, tr);
		const run = page.incidents.find((incident) => incident.kind === "run");
		expect(run?.body).toBe(
			"Der geplante Lauf wurde nicht beendet und ist seitdem nicht gelungen."
		);
		expect(scheduledRunOutcome(FAILED_RUN, tr)).toBe(
			"(geplanter Lauf, fehlgeschlagen)"
		);
		expect(bracketedRunOutcome(FAILED_RUN, tr)).toBe("(fehlgeschlagen)");
		expect(runOutcomeAgo(FAILED_RUN, "vor 5 Min.", tr)).toBe(
			"fehlgeschlagen vor 5 Min."
		);
	});

	test("composed accessible names carry no English model word", async () => {
		await mountGerman();
		const boards = buildBoards(SNAPSHOT, NOW);
		const names = [...boards.arrivals, ...boards.departures].map(
			flightAccessibleName
		);
		expect(names.join("\n")).toContain("Lauf fehlgeschlagen");
		const layout = buildFlowLayout(SNAPSHOT, {
			composer: null,
			engaged: [],
			expanded: [],
			stubFor: null,
			tl: tr,
		});
		const lane = layout.nodes.find((node) => node.kind === "lane");
		expect(lane?.kind === "lane" ? lane.label : null).toBe("Nicht zugewiesen");
		const forumNames = forumCategories(SNAPSHOT).map((c) => c.name);
		expect(forumNames).toContain("Ohne Kategorie");
		const quiz = buildQuizBoard(SNAPSHOT);
		expect(quiz.columns.map((column) => column?.name)).toContain(
			"Nicht zugewiesen"
		);
		const books = collectionBooks(SNAPSHOT, tr);
		expect(books.map((book) => book.title)).toContain("Nicht zugewiesen");
		const [firstBook] = books;
		expect(firstBook).toBeDefined();
		if (firstBook) {
			expect(progressLabel({ ...firstBook, chapters: [] }, tr)).toBe(
				"Noch keine Kapitel"
			);
		}
		const failing = SNAPSHOT.threads[1] as InterfaceThread;
		expect(mailStatusChip(failing)?.label).toBe("Lauf fehlgeschlagen");
		expect(visitVillagerLabel("Ada", "attention", tr)).toBe(
			"Ada besuchen (braucht Aufmerksamkeit)"
		);
		expect(visitVillagerLabel("Ada", "idle", tr)).toBe("Ada besuchen");
	});
});
