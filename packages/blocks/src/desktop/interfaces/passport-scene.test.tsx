import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";

// The DOM first, before React loads. The act props, the page faces and the
// villager plates are drei `Html` over three.js meshes; outside a Canvas,
// render them in place and give the frame hooks a stand-in.
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));
const fiber = await import("@react-three/fiber");
mock.module("@react-three/fiber", () => ({
	...fiber,
	useFrame: () => undefined,
	useThree: (select?: (state: unknown) => unknown) => {
		const state = {
			camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1 },
			gl: { domElement: globalThis.document?.createElement("canvas") },
			invalidate: () => undefined,
			size: { height: 800, width: 1280 },
		};
		return select ? select(state) : state;
	},
}));
// Toon materials build three.js textures; the desk's meshes are not under test.
const materials = await import("./game3d-materials.tsx");
mock.module("./game3d-materials.tsx", () => ({
	...materials,
	CurvedBasicMaterial: () => null,
	ToonMaterial: () => null,
	ToonMesh: () => null,
}));

// Villagers build three.js rigs: stand them in as their plates, wired as
// the scene wires them (a plate's select applies for a visa). Photo
// villagers (no plate) are counted by their ids.
const villager = await import("./game3d-villager.tsx");
const { VillagerPlate } = villager;
mock.module("./game3d-villager.tsx", () => ({
	...villager,
	Villagers: ({
		iconOnly,
		onSelect,
		plates = true,
		villagers,
	}: {
		iconOnly?: boolean;
		onSelect?: (id: string) => void;
		plates?: boolean;
		villagers: readonly import("./game3d-villager.tsx").VillagerSpec[];
	}) =>
		villagers.map((spec) =>
			plates && spec.plate !== false ? (
				<VillagerPlate
					iconOnly={spec.iconOnly ?? iconOnly}
					key={spec.id}
					onSelect={() => onSelect?.(spec.id)}
					selected={false}
					spec={spec}
				/>
			) : (
				<span data-photo={spec.id} key={spec.id} />
			)
		),
}));

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	usefulStateFixture,
} = await import("./game-acts-fixture.ts");
const { actOverlays, overlayBudget, stageAgents, youSpotSlots } = await import(
	"./game3d-acts.ts"
);
const { GAME3D_DAY } = await import("./game3d-palette.ts");
const { askOwners } = await import("./interface-ask-card.tsx");
const {
	actOfficers,
	deskPaths,
	officerLife,
	PassportActProps,
	deskKeeps,
	ROOMY_DESK,
	stationLayout,
} = await import("./passport-acts.tsx");
const { DeskScene, layoutDesk } = await import("./passport-desk.tsx");
const { deskArt } = await import("./passport-palette.ts");
const { bookletSpreads, buildPassport, singleSpreads } = await import(
	"./passport-model.ts"
);
const { VisaFace } = await import("./passport-page-face.tsx");

afterAll(async () => {
	mock.restore();
	if (GlobalRegistrator.isRegistered) {
		await GlobalRegistrator.unregister();
	}
});

/**
 * The desk and its act props (PassportActProps) and the villager plates
 * exactly as PassportInterface builds them at a `width` stage (its overlay
 * budget, booklet mode and cast), with the opening spread's faces printed
 * on the pages, rendered as the kit's plates.
 */
function renderDesk(
	width: number,
	snapshot: InterfaceSnapshot = usefulStateFixture()
) {
	const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
	const passport = buildPassport(snapshot);
	const mode = width < 640 ? "single" : "spread";
	const layout = layoutDesk(passport, mode);
	const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
	const slots = youSpotSlots(
		acts,
		unownedAsks(snapshot),
		onStage.map((item) => item.agentId)
	);
	const budget = overlayBudget(width, { domTargets: true });
	const shown = budget.fill(
		actOverlays(
			onStage,
			slots,
			offStage,
			onStage.find((item) => item.act === "working")?.agentId ?? null,
			{ reduced: true }
		).filter((item) =>
			deskKeeps(item, layout, {
				iconOnly: budget.iconOnly,
				roomy: width >= ROOMY_DESK,
			})
		)
	);
	const asked: string[] = [];
	const applied: string[] = [];
	const opened: string[] = [];
	const looks = new Map(
		snapshot.agents.map((agent) => [agent.id, {} as never])
	);
	const officers = actOfficers({
		acts,
		layout,
		looks,
		narrow: budget.iconOnly,
		onAsk: (askId) => asked.push(askId),
		reduced: true,
		shown,
	});
	const paths = deskPaths(layout);
	const spreads =
		mode === "single"
			? singleSpreads(passport.pages.length)
			: bookletSpreads(passport.pages.length);
	// The opening's first two visa pages, or a phone's first one.
	const spread = spreads[mode === "single" ? 3 : 2];
	const faceOf = (index: number | null | undefined) => {
		const page =
			index === null || index === undefined ? null : passport.pages[index];
		if (page?.kind !== "visa") {
			return null;
		}
		return (
			<VisaFace
				activeThreadId={null}
				country={
					passport.countries.find((item) => item.id === page.countryId) ?? null
				}
				onOpen={(threadId) => opened.push(threadId)}
				page={page}
				status={null}
			/>
		);
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const errors = console.error;
	// React warns about three.js tags in a DOM tree; they are not under test.
	console.error = () => undefined;
	try {
		act(() =>
			root.render(
				<DeskScene
					actors={{
						iconOnly: budget.iconOnly,
						officers,
						paths,
						props: (
							<PassportActProps
								acts={acts}
								clock={FIXTURE_CLOCK}
								iconOnly={budget.iconOnly}
								layout={layout}
								noteIcons={width < ROOMY_DESK}
								nowMs={FIXTURE_NOW}
								offStage={offStage}
								onAsk={(askId) => asked.push(askId)}
								onBlocker={() => undefined}
								onQueue={() => undefined}
								onStage={onStage}
								owners={askOwners(acts)}
								paths={paths}
								reduced
								shown={shown}
								slots={slots}
								snapshot={snapshot}
							/>
						),
					}}
					art={deskArt(false)}
					faces={{ left: faceOf(spread?.left), right: faceOf(spread?.right) }}
					layout={layout}
					looks={looks}
					onApply={(agentId) => applied.push(agentId)}
					onTurnDone={() => undefined}
					pages={passport.pages}
					reducedMotion
					spread={spread}
					theme={GAME3D_DAY}
					turning={null}
				/>
			)
		);
	} catch (error) {
		console.error = errors;
		const inner = (error as { errors?: unknown[] }).errors ?? [error];
		throw new Error(inner.map((item) => String(item)).join("\n"));
	} finally {
		console.error = errors;
	}
	const dispose = () => {
		act(() => root.unmount());
		container.remove();
	};
	return {
		acts,
		applied,
		asked,
		container,
		dispose,
		layout,
		opened,
		passport,
		spread,
	};
}

const EXPECTED = { alarm: 3, notice: 1, suggestion: 1, tray: 1, unread: 1 };

function plateOf(container: HTMLElement, agentId: string) {
	const plate = container.querySelector<HTMLButtonElement>(
		`button[data-act-agent="${agentId}"]`
	);
	if (!plate) {
		throw new Error(`no plate for ${agentId}`);
	}
	return plate;
}

function deniedStamps(container: HTMLElement) {
	return [...container.querySelectorAll("[data-iso-plate]")].filter(
		(item) => item.textContent === "Denied"
	);
}

describe("passport desk: the act layer's targets (test 21)", () => {
	for (const width of [1280, 390]) {
		test(`every exempt target is a focusable, named control at ${width}`, () => {
			const { acts, container, dispose } = renderDesk(width);
			const narrow = width < 640;
			try {
				for (const [kind, count] of Object.entries(EXPECTED)) {
					const targets = [
						...container.querySelectorAll<HTMLButtonElement>(
							`[data-act-target="${kind}"]`
						),
					];
					expect(targets).toHaveLength(count);
					for (const target of targets) {
						expect(target.tabIndex).toBe(0);
						expect(target.hasAttribute("data-iso-target")).toBe(true);
						expect(target.getAttribute("aria-label")?.length).toBeGreaterThan(
							10
						);
						// The notice is a queue plate: it keeps its words at 390.
						expect(target.hasAttribute("data-icon-only")).toBe(
							narrow && kind !== "notice"
						);
					}
				}
				const alarms = [
					...container.querySelectorAll('[data-act-target="alarm"]'),
				].map((item) => item.getAttribute("aria-label"));
				expect(alarms).toEqual([
					"Di stopped: Tests failed, 20 minutes ago.",
					"Di stopped: Nightly backup failed, 6 hours ago.",
					"Ed stopped: Interrupted, about 1 hour ago.",
				]);
				// One Tab stop per agent: its villager's plate on its tab, named
				// by its act.
				const plates = [
					...container.querySelectorAll<HTMLButtonElement>(
						"button[data-act-agent]"
					),
				];
				expect(plates).toHaveLength(acts.size);
				for (const plate of plates) {
					const officer = acts.get(plate.getAttribute("data-act-agent") ?? "");
					expect(plate.tabIndex).toBe(0);
					expect(plate.getAttribute("aria-label")).toStartWith(
						officer?.ariaLabel ?? "(none)"
					);
				}
				// The asks wait at the customs desk as slips with queue plates.
				const queue = [
					...container.querySelectorAll('[data-you-spot="slot"]'),
				].map((item) => item.textContent);
				expect(queue).toContain("Ada · 14m");
				const budgeted = container.querySelectorAll("[data-budgeted-overlay]");
				expect(budgeted.length).toBeLessThanOrEqual(narrow ? 8 : 16);
			} finally {
				dispose();
			}
		});
	}

	test("villager plates: Ada's opens her ask; Cy's applies for a visa (15a)", () => {
		const { applied, asked, container, dispose } = renderDesk(1280);
		try {
			const ada = plateOf(container, FIXTURE_AGENT_IDS.ada);
			expect(ada.hasAttribute("aria-pressed")).toBe(false);
			act(() => ada.click());
			expect(asked).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
			expect(applied).toEqual([]);
			const cy = plateOf(container, FIXTURE_AGENT_IDS.cy);
			expect(cy.getAttribute("aria-pressed")).toBe("false");
			act(() => cy.click());
			expect(applied).toEqual([FIXTURE_AGENT_IDS.cy]);
			expect(asked).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		} finally {
			dispose();
		}
	});

	test("DENIED marks counted failures only: Di's, not Ed's interrupted run", () => {
		const { container, dispose } = renderDesk(1280);
		try {
			expect(deniedStamps(container)).toHaveLength(1);
		} finally {
			dispose();
		}
	});

	test("Di with a running thread as well still shows both alarms and DENIED", () => {
		const snapshot = usefulStateFixture();
		const di = snapshot.threads.find(
			(thread) => thread.agentIds[0] === FIXTURE_AGENT_IDS.di
		);
		const running: InterfaceSnapshot = {
			...snapshot,
			threads: [
				...snapshot.threads,
				{ ...(di as InterfaceThread), id: "t-di-live", running: true },
			],
		};
		const { container, dispose } = renderDesk(1280, running);
		try {
			const alarms = [
				...container.querySelectorAll('[data-act-target="alarm"]'),
			].map((item) => item.getAttribute("aria-label"));
			expect(alarms).toContain("Di stopped: Tests failed, 20 minutes ago.");
			expect(alarms).toContain(
				"Di stopped: Nightly backup failed, 6 hours ago."
			);
			expect(deniedStamps(container)).toHaveLength(1);
		} finally {
			dispose();
		}
	});
});

describe("passport desk: the booklet", () => {
	test("the open spread prints its visa pages: photo, name, emblem, stamps", () => {
		const { container, dispose, opened, passport, spread } = renderDesk(1280);
		try {
			const shown = [spread?.left, spread?.right].flatMap((index) => {
				const page =
					index === null || index === undefined ? null : passport.pages[index];
				return page?.kind === "visa" && page.countryId ? [page.countryId] : [];
			});
			expect(shown).toHaveLength(2);
			// Each shown visa page has its agent's villager in the photo frame.
			const photos = [
				...container.querySelectorAll('[data-photo^="photo:"]'),
			].map((item) => item.getAttribute("data-photo"));
			expect(photos).toEqual(shown.map((id) => `photo:${id}`));
			const faces = container.querySelectorAll("[data-passport-face]");
			expect(faces).toHaveLength(2);
			const names = shown.map(
				(id) => passport.countries.find((item) => item.id === id)?.agent.name
			);
			for (const [index, face] of [...faces].entries()) {
				expect(face.querySelector("h2")?.textContent).toBe(names[index] ?? "");
				expect(face.textContent).toContain("PHOTO");
			}
			// Each conversation is a stamp that opens it.
			const stamp = container.querySelector<HTMLButtonElement>(
				"[data-passport-face] button[data-thread-id]"
			);
			act(() => stamp?.click());
			expect(opened).toEqual([stamp?.getAttribute("data-thread-id") ?? ""]);
		} finally {
			dispose();
		}
	});

	test("a phone opens one page at a time", () => {
		const { container, dispose, layout } = renderDesk(390);
		try {
			expect(layout.mode).toBe("single");
			expect(container.querySelectorAll("[data-passport-face]")).toHaveLength(
				1
			);
			expect(container.querySelectorAll('[data-photo^="photo:"]')).toHaveLength(
				1
			);
		} finally {
			dispose();
		}
	});

	test("a back tab's notes ride in the clip strip, off the printed page", () => {
		const passport = buildPassport(usefulStateFixture());
		for (const mode of ["spread", "single"] as const) {
			const layout = layoutDesk(passport, mode);
			const di = layout.stations.find(
				(station) => station.id === FIXTURE_AGENT_IDS.di
			);
			expect(di?.edge).toBe("top");
			const place = di ? stationLayout(di, mode === "single") : null;
			const offset = place?.alarms ?? [0, 0, 0];
			// Toward the viewer from the villager (desk depth b), but still
			// behind the booklet's back edge: in the strip, not on the page.
			const toward = (offset[0] + offset[2]) / Math.SQRT2;
			expect(toward).toBeGreaterThan(0.5);
			expect((di?.ab[1] ?? 0) + toward).toBeLessThan(-layout.halfB - 0.3);
			// Further alarms step along the strip, not up into the row.
			expect(place?.alarmRows).toBe(0);
			expect(place?.alarmSide).toBe("center");
		}
		const layout = layoutDesk(passport, "spread");
		const side = layout.stations.find((station) => station.edge === "left");
		expect(side ? stationLayout(side).alarmSide : null).toBe("left");
		// A side tab's notes hang outward, off the booklet's side.
		const board = side ? stationLayout(side).board : undefined;
		const out = ((board?.[0] ?? 0) - (board?.[2] ?? 0)) / Math.SQRT2;
		expect(out).toBeLessThan(-1);
	});

	test("a phone or a squeezed spread keeps work bubbles off the printed page", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const passport = buildPassport(snapshot);
		const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
		const slots = youSpotSlots(
			acts,
			unownedAsks(snapshot),
			onStage.map((item) => item.agentId)
		);
		const focus =
			onStage.find((item) => item.act === "working")?.agentId ?? null;
		// Cy, the focus agent, works on a side tab: its bubble would push its
		// plate onto the page.
		expect(focus).toBe(FIXTURE_AGENT_IDS.cy);
		const cyTab = layoutDesk(passport, "single").stations.find(
			(station) => station.country?.agent.id === FIXTURE_AGENT_IDS.cy
		);
		expect(cyTab?.edge).toBe("left");
		const items = actOverlays(onStage, slots, offStage, focus, {
			reduced: false,
		});
		const kept = (
			mode: "single" | "spread",
			stage: { iconOnly: boolean; roomy: boolean }
		) => {
			const layout = layoutDesk(passport, mode);
			return items
				.filter((item) => deskKeeps(item, layout, stage))
				.map((item) => item.id);
		};
		const bubble = /^(work|wait|done):/;
		const wide = kept("spread", { iconOnly: false, roomy: true });
		expect(wide).toContain(`work:${FIXTURE_AGENT_IDS.cy}`);
		expect(wide).toContain(`work:${FIXTURE_AGENT_IDS.io}`);
		// A spread squeezed beside a sheet drops the side tab's bubble only:
		// a back tab's (Io's) still rises off the booklet.
		const squeezed = kept("spread", { iconOnly: false, roomy: false });
		expect(squeezed).toEqual(
			wide.filter((id) => id !== `work:${FIXTURE_AGENT_IDS.cy}`)
		);
		const phone = kept("single", { iconOnly: true, roomy: false });
		// No work bubble at all, the focus agent's included ...
		expect(phone.filter((id) => bubble.test(id))).toEqual([]);
		// ... and every other overlay (the notes, the status words) is the
		// budget's to choose, as on a wide stage.
		expect(phone).toEqual(wide.filter((id) => !bubble.test(id)));
		expect(phone).toContain(`next:${FIXTURE_AGENT_IDS.cy}`);
		// So the phone's cast has no work bubble showing.
		const shown = new Set(phone);
		for (const spec of actOfficers({
			acts,
			layout: layoutDesk(passport, "single"),
			looks: new Map(snapshot.agents.map((agent) => [agent.id, {} as never])),
			narrow: true,
			onAsk: () => undefined,
			reduced: false,
			shown,
		})) {
			const act = acts.get(spec.id);
			if (act && (act.act === "working" || act.act === "waiting")) {
				expect(spec.bubble).toBe(false);
			}
		}
	});

	test("a phone hangs a side tab's status board below its plate", () => {
		const passport = buildPassport(usefulStateFixture());
		const layout = layoutDesk(passport, "single");
		const side = layout.stations.find((station) => station.edge === "left");
		const board = side ? stationLayout(side, true).board : undefined;
		// Toward the viewer (desk depth b) from the villager, so its widest
		// word ("Next: write tests") clears the page's front edge for the
		// lowest side tab.
		const toward = ((board?.[0] ?? 0) + (board?.[2] ?? 0)) / Math.SQRT2;
		expect(toward).toBeGreaterThanOrEqual(1.5);
	});

	test("a phone keeps a delivery's words off the next tabs", () => {
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		const gu = acts.get(FIXTURE_AGENT_IDS.gu);
		expect(gu?.act).toBe("delivering");
		const says = (narrow: boolean) =>
			gu
				? officerLife(gu, [0, 0, 0], false, narrow).steps.some(
						(step) => step.do === "say" && step.bubble !== null
					)
				: false;
		expect(says(false)).toBe(true);
		expect(says(true)).toBe(false);
	});
});
