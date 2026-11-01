import { describe, expect, it } from "bun:test";
import {
	isSoundEventId,
	isSoundSettingRowId,
	SOUND_EVENT_IDS,
	SOUND_EVENTS,
	SOUND_SETTING_ROW_IDS,
	SOUND_SETTING_ROWS,
	soundEventDefaultEnabled,
	soundSettingRow,
} from "./sound-catalog.ts";

describe("sound catalog", () => {
	it("defines every event and maps it to an existing row that lists it", () => {
		for (const id of SOUND_EVENT_IDS) {
			const def = SOUND_EVENTS[id];
			expect(def.id).toBe(id);
			expect(def.label.length).toBeGreaterThan(0);
			expect(soundSettingRow(def.settingRow).ids).toContain(id);
		}
	});

	it("covers every row id once, and every event exactly once across rows", () => {
		expect(SOUND_SETTING_ROWS.map((row) => row.id).sort()).toEqual(
			[...SOUND_SETTING_ROW_IDS].sort()
		);
		const listed = SOUND_SETTING_ROWS.flatMap((row) => [...row.ids]);
		expect([...listed].sort()).toEqual([...SOUND_EVENT_IDS].sort());
	});

	it("keeps row labels unique and describes every row", () => {
		const labels = SOUND_SETTING_ROWS.map((row) => row.label);
		expect(new Set(labels).size).toBe(labels.length);
		for (const row of SOUND_SETTING_ROWS) {
			expect(row.description.length).toBeGreaterThan(0);
		}
	});

	it("groups multi-cue rows the way Settings shows them", () => {
		expect(soundSettingRow("join-leave").ids).toEqual([
			"call-join",
			"call-leave",
			"call-error",
		]);
		expect(soundSettingRow("mute-unmute").ids).toEqual(["mute", "unmute"]);
		expect(soundSettingRow("alerts").ids).toEqual(["alert"]);
		expect(SOUND_SETTING_ROWS).toHaveLength(14);
	});

	it("leaves message-sent off by default and everything else on", () => {
		expect(soundEventDefaultEnabled("message-sent")).toBe(false);
		for (const id of SOUND_EVENT_IDS) {
			if (id !== "message-sent") {
				expect(soundEventDefaultEnabled(id)).toBe(true);
			}
		}
	});

	it("uses the planned cooldowns and classes", () => {
		expect(SOUND_EVENTS.message.cooldownMs).toBe(600);
		expect(SOUND_EVENTS.mute.cooldownMs).toBe(0);
		expect(SOUND_EVENTS.unmute.cooldownMs).toBe(0);
		expect(SOUND_EVENTS["run-complete"].cooldownMs).toBe(250);
		expect(SOUND_EVENTS["run-failed"].priority).toBe(3);
		expect(SOUND_EVENTS["quest-complete"].class).toBe("reward");
		expect(SOUND_EVENTS["call-join"].class).toBe("call");
		expect(SOUND_EVENTS.mute.class).toBe("feedback");
	});

	it("guards ids", () => {
		expect(isSoundEventId("run-complete")).toBe(true);
		expect(isSoundEventId("alerts")).toBe(false);
		expect(isSoundSettingRowId("alerts")).toBe(true);
		expect(isSoundSettingRowId(42)).toBe(false);
		expect(() => soundSettingRow("nope" as never)).toThrow();
	});
});
