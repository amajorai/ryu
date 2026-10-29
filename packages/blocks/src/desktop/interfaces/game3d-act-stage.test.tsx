import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The blocks' 3D pieces need a Canvas; record the props they get instead.
const seen: Record<string, Record<string, unknown>[]> = {};
const recorder = (name: string) => (props: Record<string, unknown>) => {
	seen[name] = [...(seen[name] ?? []), props];
	return null;
};
const drei = await import("@react-three/drei");
mock.module("@react-three/drei", () => ({
	...drei,
	Html: ({ children }: { children: ReactNode }) => children,
}));
const meters = await import("./game3d-meters.tsx");
mock.module("./game3d-meters.tsx", () => ({
	...meters,
	ProgressPips3D: recorder("ProgressPips3D"),
	RunCue: recorder("RunCue"),
	WaitTimer3D: recorder("WaitTimer3D"),
}));
const alarm = await import("./game3d-alarm.tsx");
mock.module("./game3d-alarm.tsx", () => ({
	...alarm,
	AlarmStack: recorder("AlarmStack"),
	LimitCue: recorder("LimitCue"),
}));
const signs = await import("./game3d-signs.tsx");
mock.module("./game3d-signs.tsx", () => ({
	...signs,
	NextSign: recorder("NextSign"),
	NoticePost: recorder("NoticePost"),
	SuggestionNote: recorder("SuggestionNote"),
	TallyPlate: recorder("TallyPlate"),
	TrayItem: recorder("TrayItem"),
	UnreadMark: recorder("UnreadMark"),
}));
const apprentice = await import("./game3d-apprentice.tsx");
mock.module("./game3d-apprentice.tsx", () => ({
	...apprentice,
	ApprenticeTally: recorder("ApprenticeTally"),
}));

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act: actNow } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
	ActStation,
	LIMIT_TONE,
	limitWords,
	stationLines,
	trayPositions,
	YouSpots,
} = await import("./game3d-act-stage.tsx");
const { agentActs, unownedAsks } = await import("@ryuhq/protocol/interfaces");
const { stageAgents, youSpotSlots } = await import("./game3d-acts.ts");
const { FIXTURE_CLOCK, FIXTURE_NOW_MS, usefulStateFixture } = await import(
	"@ryuhq/protocol/interfaces-fixture"
);

afterAll(() => {
	GlobalRegistrator.unregister();
});

const snapshot = usefulStateFixture();
const acts = agentActs(snapshot, FIXTURE_NOW_MS, FIXTURE_CLOCK);
const limited = [...acts.values()].find((item) => item.act === "limited");
const working = [...acts.values()].find((item) => item.progress !== null);
if (!(limited && working)) {
	throw new Error("the fixture needs a limited and a working agent");
}
const LOCAL = { clock: FIXTURE_CLOCK, nowMs: FIXTURE_NOW_MS };

function render(node: ReactNode) {
	for (const key of Object.keys(seen)) {
		delete seen[key];
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	actNow(() => root.render(node));
	return {
		container,
		unmount: () => {
			actNow(() => root.unmount());
			container.remove();
		},
	};
}

describe("limit wording", () => {
	test("a game's limitText words the board line and the limit cue", () => {
		const limitText = (_: unknown, clearsAt: string | null) =>
			clearsAt ? `86'd till ${clearsAt}` : "86'd";
		const words = limitWords(limited, { ...LOCAL, limitText });
		expect(words).toMatch(/^(Likely )?86'd till \d\d:\d\d$/);
		const shown = new Set([`limit:${limited.agentId}`]);
		expect(stationLines(limited, shown, { ...LOCAL, limitText })).toEqual([
			{ id: `limit:${limited.agentId}`, kind: "limit", text: words ?? "" },
		]);
		const view = render(
			<ActStation
				act={limited}
				at={[0, 0, 0]}
				iconOnly={false}
				limitText={limitText}
				onAsk={() => undefined}
				onBlocker={() => undefined}
				reduced
				shown={shown}
				snapshot={snapshot}
				{...LOCAL}
			/>
		);
		expect(seen.LimitCue?.[0]?.text).toBe(words);
		expect(view.container.textContent).toContain(words ?? "missing");
		view.unmount();
	});

	test("without limitText it keeps the act's words; estimates read Likely", () => {
		expect(limitWords(limited, LOCAL)).toBe(limited.bubble?.text ?? null);
		expect(limitWords(working, LOCAL)).toBeNull();
		const estimated = {
			...limited,
			blockers: [
				{
					kind: "rate-limited" as const,
					source: "estimate" as const,
					title: "Usage limit",
				},
			],
			timer: null,
		};
		expect(
			limitWords(estimated, {
				...LOCAL,
				limitText: (_, clearsAt) => `INSERT COIN ${clearsAt ?? "soon"}`,
			})
		).toBe("Likely INSERT COIN soon");
	});
});

describe("skins", () => {
	test("ActStation hands pipSkin to the pips", () => {
		const pipSkin = { done: "gold", todo: "soil" };
		const view = render(
			<ActStation
				act={working}
				at={[1, 0, 2]}
				iconOnly={false}
				onAsk={() => undefined}
				onBlocker={() => undefined}
				pipSkin={pipSkin}
				reduced
				shown={new Set()}
				snapshot={snapshot}
				{...LOCAL}
			/>
		);
		expect(seen.ProgressPips3D?.[0]?.skin).toBe(pipSkin);
		view.unmount();
	});

	test("YouSpots hands timerSkin's colour to every wait timer", () => {
		const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
		const slots = youSpotSlots(
			acts,
			unownedAsks(snapshot),
			onStage.map((item) => item.agentId)
		);
		const point = (x: number) => [x, 0, 5] as [number, number, number];
		const view = render(
			<YouSpots
				iconOnly={false}
				item={{ shape: "box" }}
				layout={{
					offStage: point(9),
					slots: {
						"you-1": point(0),
						"you-2": point(1),
						"you-3": point(2),
						"you-4": point(3),
					},
					tally: point(4),
					tray: [0, 0, 3],
				}}
				nowMs={FIXTURE_NOW_MS}
				offStage={offStage}
				onAsk={() => undefined}
				onOpenQueue={() => undefined}
				onStage={onStage}
				owners={new Map()}
				reduced
				shown={new Set()}
				slots={slots}
				snapshot={snapshot}
				timerSkin={{ color: "led" }}
			/>
		);
		const timers = seen.WaitTimer3D ?? [];
		expect(timers.length).toBeGreaterThan(0);
		expect(timers.every((props) => props.color === "led")).toBe(true);
		expect(seen.TrayItem?.length).toBe(
			onStage.filter((item) => item.act === "delivering" && item.ask).length
		);
		view.unmount();
	});
});

describe("tray layout", () => {
	test("wraps every trayMax items so the tray never reaches the slots", () => {
		const layout = { tray: [0, 0, 0] as [number, number, number] };
		expect(trayPositions(layout, 4)).toEqual([
			[0, 0, 0],
			[0.7, 0, 0],
			[1.4, 0, 0],
			[0, 0, -0.7],
		]);
		const capped = trayPositions(
			{
				...layout,
				trayMax: 2,
				trayRowStep: [0, 0, -1],
				trayStep: [0.5, 0, 0],
			},
			5
		);
		expect(Math.max(...capped.map((at) => at[0]))).toBe(0.5);
		expect(capped.at(-1)).toEqual([0, 0, -2]);
		expect(trayPositions(layout, 0)).toEqual([]);
	});
});

describe("alarm plates", () => {
	test("plates sit over the first beacon; the default step adds no world climb", async () => {
		const { ALARM_SPACING, ALARM_STEP, alarmPlateAt } = await import(
			"./game3d-alarm.tsx"
		);
		expect(ALARM_STEP).toEqual([0, 0, 0]);
		for (const index of [0, 1, 2]) {
			const at = alarmPlateAt(index);
			expect(at[0] + index * ALARM_SPACING).toBeCloseTo(0);
			expect(at[1]).toBeCloseTo(1.15);
		}
		// A custom step climbs in world units over the same column.
		const stepped = alarmPlateAt(2, [0, 0.55, 0]);
		expect(stepped[0] + 2 * ALARM_SPACING).toBeCloseTo(0);
		expect(stepped[1]).toBeCloseTo(1.15 + 1.1);
	});

	test("ActStation passes layout.alarmStep to the alarm stack", () => {
		const blocked = [...acts.values()].find((item) => item.blockers.length > 1);
		if (!blocked) {
			throw new Error("the fixture needs an agent with two alarms");
		}
		const alarmStep: [number, number, number] = [-0.35, 0.45, -0.35];
		const view = render(
			<ActStation
				act={blocked}
				at={[0, 0, 0]}
				iconOnly={false}
				layout={{ alarmStep }}
				onAsk={() => undefined}
				onBlocker={() => undefined}
				reduced
				shown={new Set()}
				snapshot={snapshot}
				{...LOCAL}
			/>
		);
		expect(seen.AlarmStack?.[0]?.step).toEqual(alarmStep);
		view.unmount();
	});

	test("ActStation hangs alarms on the figure's open side unless the layout says", () => {
		const blocked = [...acts.values()].find((item) => item.blockers.length > 0);
		if (!blocked) {
			throw new Error("the fixture needs a blocked agent");
		}
		const stackFor = (layout: Record<string, unknown>) => {
			const view = render(
				<ActStation
					act={blocked}
					at={[0, 0, 0]}
					iconOnly={false}
					layout={layout}
					onAsk={() => undefined}
					onBlocker={() => undefined}
					reduced
					shown={new Set()}
					snapshot={snapshot}
					{...LOCAL}
				/>
			);
			const props = seen.AlarmStack?.[0] ?? {};
			view.unmount();
			return { rows: props.rows, side: props.side };
		};
		// The default alarms sit screen-right of a figure at the origin.
		expect(stackFor({})).toEqual({ rows: undefined, side: "right" });
		expect(stackFor({ alarms: [-0.8, 0, 0.8] }).side).toBe("left");
		// Measured from the figure: alarms right over it hang centred.
		expect(stackFor({ figure: [0.75, 0, -0.75] }).side).toBe("center");
		expect(
			stackFor({ alarms: [0.4, 0, 0.4], figure: [1.2, 0, -0.4] }).side
		).toBe("left");
		// A game's own side and rows win.
		expect(stackFor({ alarmSide: "left" }).side).toBe("left");
		expect(stackFor({ alarmSide: "auto" }).side).toBe("right");
		expect(stackFor({ alarmRows: -1, alarmSide: "center" })).toEqual({
			rows: -1,
			side: "center",
		});
	});
});

describe("game skins for acts", () => {
	test("the limit line is amber by default and takes a game's tone", () => {
		const shown = new Set([`limit:${limited.agentId}`]);
		const station = (limitTone?: string) =>
			render(
				<ActStation
					act={limited}
					at={[0, 0, 0]}
					iconOnly={false}
					limitTone={limitTone}
					onAsk={() => undefined}
					onBlocker={() => undefined}
					reduced
					shown={shown}
					snapshot={snapshot}
					{...LOCAL}
				/>
			);
		const plain = station();
		const line = plain.container.querySelector(
			"[data-budgeted-overlay='limit']"
		);
		for (const token of LIMIT_TONE.split(" ")) {
			expect(line?.classList.contains(token)).toBe(true);
		}
		plain.unmount();
		const themed = station("bg-(--gk-accent)");
		const themedLine = themed.container.querySelector(
			"[data-budgeted-overlay='limit']"
		);
		expect(themedLine?.classList.contains("bg-(--gk-accent)")).toBe(true);
		expect(themedLine?.classList.contains("bg-(--gk-warn)")).toBe(false);
		themed.unmount();
	});

	test("askItem replaces the letter and keeps the destructive accent", async () => {
		const { askItem } = await import("./game3d-acts.ts");
		const asking = [...acts.values()].find(
			(item) => item.carry === "approval" || item.carry === "question"
		);
		if (!asking) {
			throw new Error("the fixture needs an asking agent");
		}
		const card = { accent: "clue", shape: "tablet" as const };
		const carried = askItem(asking, {
			askItem: card,
			deliverable: { shape: "box" },
			letter: { accent: "seal", destructiveAccent: "danger" },
		});
		const destructive = asking.ask?.choices?.some(
			(choice) => choice.destructive
		);
		expect(carried?.shape).toBe("tablet");
		expect(carried?.accent).toBe(destructive ? "danger" : "clue");
		expect(askItem(asking, { deliverable: { shape: "box" } })?.shape).not.toBe(
			"tablet"
		);
	});

	test("blockedPose picks the downed agent's final pose; kneel sits low", async () => {
		const { actLife, isRedBlocker } = await import("./game3d-acts.ts");
		const { poseLife } = await import("./game3d-life.tsx");
		const { emptyLifeFrame } = await import("./game3d-life.ts");
		const { Euler, Vector3 } = await import("three");
		const red = [...acts.values()].find(
			(item) => item.act === "blocked" && isRedBlocker(item.blockers[0])
		);
		const spots = {
			paths: { links: [], points: {} },
			station: [0, 0, 0] as [number, number, number],
		};
		expect(red).toBeDefined();
		if (red) {
			const script = actLife(
				red,
				spots,
				{
					blockedPose: "kneel",
					deliverable: { shape: "box" },
				},
				{ reduced: false }
			);
			const poses = script.steps.filter((step) => step.do === "pose");
			expect(poses.at(-1)).toEqual({ action: "kneel", do: "pose" });
		}
		const frame = { ...emptyLifeFrame(), action: "kneel" as const };
		const out = {
			armLeft: 0,
			armRight: 0,
			position: new Vector3(),
			rotation: new Euler(),
			scale: new Vector3(1, 1, 1),
		};
		poseLife(frame, out, 0, 0, true);
		expect(out.scale.y).toBeLessThan(0.8);
		expect(out.position.y).toBeLessThan(0);
		expect(out.rotation.x).toBeGreaterThan(0.2);
	});
});

describe("blocker threads", () => {
	test("a copied blocker still finds its own thread", async () => {
		const { blockerThread } = await import("./game3d-act-stage.tsx");
		const blocked = [...acts.values()].find((item) => item.blockers.length > 0);
		if (!blocked) {
			throw new Error("the fixture needs a blocked agent");
		}
		const copy = structuredClone(blocked.blockers[0]);
		if (!copy) {
			throw new Error("no blocker");
		}
		const thread = blockerThread(blocked, copy, snapshot);
		expect(thread?.blocker?.title).toBe(copy.title);
		expect(thread?.blocker).not.toBe(copy);
		expect(thread?.agentIds).toContain(blocked.agentId);
	});

	test("of two equal blockers, the act's own object and claim pick the thread", async () => {
		const { blockerThread } = await import("./game3d-act-stage.tsx");
		const blocked = [...acts.values()].find((item) => item.blockers.length > 0);
		const blocker = blocked?.blockers[0];
		const original = snapshot.threads.find(
			(thread) => thread.blocker === blocker
		);
		if (!(blocked && blocker && original?.blocker)) {
			throw new Error("the fixture needs a blocker with its thread");
		}
		const twin = {
			...original,
			blocker: structuredClone(original.blocker),
			id: `${original.id}-twin`,
		};
		const twins = { ...snapshot, threads: [...snapshot.threads, twin] };
		const mine = new Map([
			[original.id, "someone-else"],
			[twin.id, blocked.agentId],
		]);
		// The twin's own object, claimed by the act: the twin.
		expect(blockerThread(blocked, twin.blocker, twins, mine)?.id).toBe(twin.id);
		// The original's object, though another agent claims it: still the
		// same object, so the original.
		expect(blockerThread(blocked, blocker, twins, mine)?.id).toBe(original.id);
		// A copy equal to both: the act's claim decides.
		expect(
			blockerThread(blocked, structuredClone(blocker), twins, mine)?.id
		).toBe(twin.id);
		const theirs = new Map([
			[original.id, blocked.agentId],
			[twin.id, "someone-else"],
		]);
		expect(
			blockerThread(blocked, structuredClone(blocker), twins, theirs)?.id
		).toBe(original.id);
	});
});

describe("seasonal seams", () => {
	const spots = () => {
		const { offStage, onStage } = stageAgents(acts, Number.POSITIVE_INFINITY);
		const slots = youSpotSlots(
			acts,
			unownedAsks(snapshot),
			onStage.map((item) => item.agentId)
		);
		const point = (x: number) => [x, 0, 5] as [number, number, number];
		return {
			layout: {
				offStage: point(9),
				slots: {
					"you-1": point(0),
					"you-2": point(1),
					"you-3": point(2),
					"you-4": point(3),
				},
				tally: point(4),
				tray: [0, 0, 3] as [number, number, number],
			},
			offStage,
			onStage,
			slots,
		};
	};
	const youSpots = (extra: Record<string, unknown>, shot = snapshot) => {
		const { layout, offStage, onStage, slots } = spots();
		return render(
			<YouSpots
				iconOnly={false}
				item={{ shape: "box" }}
				layout={layout}
				nowMs={FIXTURE_NOW_MS}
				offStage={offStage}
				onAsk={() => undefined}
				onOpenQueue={() => undefined}
				onStage={onStage}
				owners={new Map()}
				reduced
				shown={new Set()}
				slots={slots}
				snapshot={shot}
				{...extra}
			/>
		);
	};

	test("a candle skin reaches every wait timer; the default stays the hourglass", () => {
		let view = youSpots({ timerSkin: { shape: "candle" } });
		const timers = seen.WaitTimer3D ?? [];
		expect(timers.length).toBeGreaterThan(0);
		expect(timers.every((props) => props.shape === "candle")).toBe(true);
		view.unmount();
		view = youSpots({});
		expect((seen.WaitTimer3D ?? []).every((props) => !props.shape)).toBe(true);
		view.unmount();
	});

	test("trayTag headline tags the delivered item with its answer's headline", async () => {
		const { trayHeadline } = await import("./game3d-act-stage.tsx");
		const gu = acts.get("gu");
		if (!gu) {
			throw new Error("the fixture needs Gu delivering");
		}
		expect(trayHeadline(gu, snapshot)).toBe("Edited 3 files");
		let view = youSpots({ trayTag: "headline" });
		expect(seen.TrayItem?.[0]?.tag).toBe("Edited 3 files");
		view.unmount();
		// Off by default, and never under redaction.
		view = youSpots({});
		expect(seen.TrayItem?.[0]?.tag ?? null).toBeNull();
		view.unmount();
		const redacted = { ...snapshot, privacy: "redacted" as const };
		expect(trayHeadline(gu, redacted)).toBeNull();
		// A long headline is cut.
		const long = {
			...snapshot,
			threads: snapshot.threads.map((thread) =>
				thread.id === gu.threadId && thread.outcome
					? {
							...thread,
							outcome: {
								...thread.outcome,
								headline:
									"Edited 14 files, ran 9 commands and wrote the release notes",
							},
						}
					: thread
			),
		};
		const cut = trayHeadline(gu, long) ?? "";
		expect(cut.length).toBeLessThanOrEqual(32);
		expect(cut.endsWith("…")).toBe(true);
	});

	test("renderNext replaces the next sign with the game's prop, given the next run", async () => {
		const { nextRunOf } = await import("./game3d-acts.ts");
		const [past] = (snapshot.events ?? []).filter(
			(event) => event.kind === "upcoming"
		);
		if (!past?.agentId) {
			throw new Error("the fixture needs an agent's upcoming event");
		}
		const { agentId } = past;
		// Cy's routine runs at 09:00; the act's words name its plan step
		// instead ("Next: write tests"), so a game's door needs the run.
		const run = nextRunOf(agentId, snapshot, FIXTURE_NOW_MS, FIXTURE_CLOCK);
		expect(run?.start).toBe(past.start);
		expect(run?.label).toMatch(/\d\d:\d\d$/);
		// Runs already started never count.
		expect(
			nextRunOf(agentId, snapshot, Date.parse(past.start) + 1, FIXTURE_CLOCK)
		).toBeNull();
		const later = snapshot;
		const act = acts.get(agentId);
		if (!act) {
			throw new Error("no act for the event's agent");
		}
		const calls: unknown[] = [];
		const view = render(
			<ActStation
				act={act}
				at={[0, 0, 0]}
				iconOnly={false}
				onAsk={() => undefined}
				onBlocker={() => undefined}
				reduced
				renderNext={(next) => {
					calls.push(next);
					return null;
				}}
				shown={new Set()}
				snapshot={later}
				{...LOCAL}
			/>
		);
		expect(seen.NextSign).toBeUndefined();
		expect(calls).toEqual([{ at: [-0.9, 0, -0.9], run, text: act.next }]);
		view.unmount();
		// Without it, the kit's sign as before.
		const plain = render(
			<ActStation
				act={act}
				at={[0, 0, 0]}
				iconOnly={false}
				onAsk={() => undefined}
				onBlocker={() => undefined}
				reduced
				shown={new Set()}
				snapshot={later}
				{...LOCAL}
			/>
		);
		expect(seen.NextSign?.length).toBe(1);
		plain.unmount();
	});

	test("apprentice helpers can wear the game's dress (elves)", async () => {
		const { apprenticeSpecs } = await import("./game3d-apprentice.tsx");
		const cy = acts.get("cy");
		if (!cy?.helpers) {
			throw new Error("the fixture needs Cy's helpers");
		}
		const looks = { accent: "a", hair: "h", shirt: "s", skin: "k" } as never;
		const plain = apprenticeSpecs({
			agentId: "cy",
			helpers: cy.helpers,
			looks,
			station: [0, 0, 0],
		});
		const elves = apprenticeSpecs({
			agentId: "cy",
			dress: { accessory: "beanie" },
			helpers: cy.helpers,
			looks,
			station: [0, 0, 0],
		});
		expect(plain.length).toBe(2);
		expect(plain.every((spec) => spec.looks.accessory === "none")).toBe(true);
		expect(elves.every((spec) => spec.looks.accessory === "beanie")).toBe(true);
	});
});

describe("cramped stages", () => {
	test("stationLines drops the Next line on a cramped stage only", () => {
		const cy = acts.get("cy");
		if (!cy?.next) {
			throw new Error("the fixture needs Cy's next step");
		}
		const shown = new Set(["next:cy", "progress:cy"]);
		const kinds = (cramped: boolean) =>
			stationLines(cy, shown, { ...LOCAL, cramped }).map((line) => line.id);
		expect(kinds(false)).toContain("next:cy");
		expect(kinds(true)).not.toContain("next:cy");
		expect(kinds(true)).toContain("progress:cy");
	});

	test("ActStation reads the stage's cramped flag", async () => {
		const { StageCramped } = await import("./game3d-stage.tsx");
		const cy = acts.get("cy");
		if (!cy?.next) {
			throw new Error("the fixture needs Cy's next step");
		}
		const station = (cramped: boolean) => (
			<StageCramped.Provider value={cramped}>
				<ActStation
					act={cy}
					at={[0, 0, 0]}
					iconOnly={false}
					onAsk={() => undefined}
					onBlocker={() => undefined}
					reduced
					shown={new Set(["next:cy"])}
					snapshot={snapshot}
					{...LOCAL}
				/>
			</StageCramped.Provider>
		);
		let view = render(station(false));
		expect(view.container.textContent).toContain(cy.next);
		view.unmount();
		view = render(station(true));
		expect(view.container.textContent).not.toContain(cy.next);
		view.unmount();
	});
});

describe("overlay density", () => {
	test("minimal keeps limit and cue lines only", () => {
		const shown = new Set(
			[...acts.values()].flatMap((act) =>
				["limit", "progress", "elapsed", "next", "cue"].map(
					(key) => `${key}:${act.agentId}`
				)
			)
		);
		for (const act of acts.values()) {
			const minimal = stationLines(act, shown, {
				...LOCAL,
				density: "minimal",
			}).map((line) => line.id.split(":")[0]);
			expect(minimal.every((key) => key === "limit" || key === "cue")).toBe(
				true
			);
		}
		const cy = acts.get("cy");
		if (!cy) {
			throw new Error("the fixture needs Cy");
		}
		expect(stationLines(cy, shown, LOCAL).length).toBeGreaterThan(
			stationLines(cy, shown, { ...LOCAL, density: "minimal" }).length
		);
	});

	test("ActStation reads the game's density setting", async () => {
		const { GameKitSettingsContext } = await import("./game3d-settings.tsx");
		const cy = acts.get("cy");
		if (!cy?.next) {
			throw new Error("the fixture needs Cy's next step");
		}
		const station = (overlayDensity: "full" | "minimal") => (
			<GameKitSettingsContext.Provider
				value={{ overlayDensity, workBubbles: true }}
			>
				<ActStation
					act={cy}
					at={[0, 0, 0]}
					iconOnly={false}
					onAsk={() => undefined}
					onBlocker={() => undefined}
					reduced
					shown={new Set(["next:cy"])}
					snapshot={snapshot}
					{...LOCAL}
				/>
			</GameKitSettingsContext.Provider>
		);
		let view = render(station("full"));
		expect(view.container.textContent).toContain(cy.next);
		view.unmount();
		view = render(station("minimal"));
		expect(view.container.textContent).not.toContain(cy.next);
		view.unmount();
	});
});
