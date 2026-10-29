import { describe, expect, it } from "bun:test";
import {
	actionForLiveActivity,
	helloLiveActivity,
	helloLiveActivityRows,
	isLiveStatus,
	type LiveActivity,
	type LiveActivityContribution,
	type LiveActivitySourceMap,
	liveActivitiesFromResponse,
	renderLiveActivityTarget,
	statusFromRow,
	validateLiveActivity,
} from "./live-activity.ts";

describe("live activity vocabulary", () => {
	it("exposes the five statuses mirroring mobile AgentActivity", () => {
		expect(isLiveStatus("running")).toBe(true);
		expect(isLiveStatus("waiting")).toBe(true);
		expect(isLiveStatus("review")).toBe(true);
		expect(isLiveStatus("done")).toBe(false);
		expect(isLiveStatus("error")).toBe(false);
	});

	it("maps a wire status through the statusMap, then literals, then running", () => {
		const map: LiveActivitySourceMap = {
			status: "state",
			statusMap: { in_progress: "running" },
		};
		expect(statusFromRow({ state: "in_progress" }, map)).toBe("running");
		// A literal status passes through.
		expect(statusFromRow({ state: "waiting" }, map)).toBe("waiting");
		// A known status with no map entry passes through.
		expect(statusFromRow({ state: "done" }, map)).toBe("done");
		// An unknown value falls back to running (the backend need not speak our vocabulary).
		expect(statusFromRow({ state: "wibble" }, map)).toBe("running");
		// A missing status key defaults to running.
		expect(statusFromRow({}, map)).toBe("running");
	});

	it("normalizes 0..100 progress to 0..1", () => {
		const contribution: LiveActivityContribution = {
			id: "p",
			title: "Progress",
			spec: {
				source: {
					http: { method: "GET", path: "/api/x" },
					items: "rows",
					map: { id: "id", title: "title" },
				},
				map: {
					progress: "percent",
					status: "state",
					statusMap: { active: "running" },
				},
			},
		};
		const [row] = liveActivitiesFromResponse(
			contribution,
			{ rows: [{ id: "a", title: "A", percent: 40, state: "active" }] },
			0
		);
		expect(row?.activity.progress).toBe(0.4);
		const [over] = liveActivitiesFromResponse(
			contribution,
			{ rows: [{ id: "b", title: "B", percent: 120 }] },
			0
		);
		expect(over?.activity.progress).toBe(1);
	});

	it("maps a source response to live activity cards", () => {
		const contribution: LiveActivityContribution = {
			...helloLiveActivity,
			plugin: "@ryu/hello",
		};
		const rows = liveActivitiesFromResponse(
			contribution,
			{
				runs: [
					{
						id: "r1",
						title: "Ship docs",
						run_status: "running",
						folder_path: "/work/docs",
					},
					{
						id: "r2",
						title: "Refactor",
						run_status: "completed",
						folder_path: "/work/ryu",
					},
				],
			},
			1_700_000_000_000
		);
		// The hello source filters `run_status == "running"`, so only the live row
		// becomes a card.
		expect(rows).toHaveLength(1);
		const [running] = rows;
		expect(running?.activity.status).toBe("running");
		expect(running?.activity.id).toBe("plugin:@ryu/hello:hello:r1");
		expect(running?.activity.appId).toBe("@ryu/hello");
		expect(running?.activity.detail).toBe("/work/docs");
	});

	it("drops rows without a usable id/title (forgiving)", () => {
		const rows = liveActivitiesFromResponse(
			helloLiveActivity,
			{ runs: [{ run_status: "running" }] },
			0
		);
		expect(rows).toEqual([]);
	});

	it("returns an empty list for a non-array payload", () => {
		const rows = liveActivitiesFromResponse(
			helloLiveActivity,
			{ nope: true },
			0
		);
		expect(rows).toEqual([]);
	});

	it("renders the target route template against the raw row", () => {
		const path = renderLiveActivityTarget(helloLiveActivity, {
			id: "convo-1",
			folder_path: "/work docs",
		});
		expect(path).toBe("/chat?conversationId=convo-1");
	});

	it("builds an activation action from the target", () => {
		const action = actionForLiveActivity(helloLiveActivity, { id: "convo-1" });
		expect(action).toEqual({
			kind: "route",
			path: "/chat?conversationId=convo-1",
		});
		// No target → no action.
		expect(
			actionForLiveActivity(
				{ ...helloLiveActivity, spec: undefined },
				{ id: "x" }
			)
		).toBeUndefined();
	});

	it("validates shape without throwing", () => {
		expect(validateLiveActivity(helloLiveActivity).ok).toBe(true);
		const bad = validateLiveActivity({ id: "", title: "x" });
		expect(bad.ok).toBe(false);
		expect(bad.errors.some((e) => e.includes('"id"'))).toBe(true);
		expect(validateLiveActivity(42).ok).toBe(false);
	});

	it("reports missing required labels individually", () => {
		expect(validateLiveActivity({})).toEqual({
			ok: false,
			errors: [
				'live activity: "id" must be a non-empty string',
				'live activity: "title" must be a non-empty string',
			],
		});
		expect(validateLiveActivity({ id: "activity", title: 0 }).errors).toEqual([
			'live activity: "title" must be a non-empty string',
		]);
	});
	it("renders JSON field values and leaves absent values empty", () => {
		const contribution = {
			...helloLiveActivity,
			spec: {
				target: "/{{item.obj}}/{{item.flag}}/{{item.count}}/{{item.missing}}",
			},
		};
		expect(
			renderLiveActivityTarget(contribution, {
				obj: { nested: [1, "a"] },
				flag: false,
				count: 0,
			})
		).toBe(
			`/${encodeURIComponent(JSON.stringify({ nested: [1, "a"] }))}/false/0/`
		);
	});
	it("keeps a card when its optional progress field is not finite", () => {
		const contribution: LiveActivityContribution = {
			id: "progress",
			title: "Progress",
			spec: {
				source: { http: { method: "GET", path: "/api/runs" }, items: "runs" },
				map: { progress: "percent" },
			},
		};
		const [row] = liveActivitiesFromResponse(
			contribution,
			{ runs: [{ id: "r1", title: "Run", percent: Number.NaN }] },
			0
		);
		expect(row?.activity.title).toBe("Run");
		expect(row?.activity.progress).toBeUndefined();
	});

	it("carries a renderable canned example", () => {
		const rows = helloLiveActivityRows();
		expect(rows).toHaveLength(1);
		// The canned payload is typed as a LiveActivity for consumers.
		const first: LiveActivity = rows[0]!.activity;
		expect(first.status).toBe("running");
	});
});
