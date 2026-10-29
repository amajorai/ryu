import { expect, it } from "bun:test";
import {
	Calendar04Icon,
	Mail01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { triggerMeta, triggerTooltip } from "./workflow-triggers.tsx";

it("looks up only declared toolkit glyphs and preserves case-insensitive names", () => {
	for (const toolkit of ["gmail", "GMAIL", "GoogleMail"]) {
		expect(
			triggerMeta({ type: "composio", toolkit, trigger_slug: "event" }).icon
		).toBe(Mail01Icon);
	}
	expect(
		triggerMeta({
			type: "composio",
			toolkit: "Google_Calendar",
			trigger_slug: "event",
		}).icon
	).toBe(Calendar04Icon);
	for (const toolkit of ["constructor", "toString", "__proto__", "future"]) {
		expect(
			triggerMeta({ type: "composio", toolkit, trigger_slug: "event" })
		).toEqual({ icon: ZapIcon, label: toolkit });
	}
});

it("retains event display names and fixed-interval/cron fallback text", () => {
	expect(
		triggerMeta({ type: "event", event: "com.ryu.app#new-message" }).label
	).toBe("new-message");
	for (const every of ["5m", "1h", "1d", " 30s "]) {
		expect(
			triggerTooltip({ type: "schedule", every }, null)?.startsWith(
				`Runs every ${every} · next in `
			)
		).toBe(true);
	}
	for (const every of ["invalid", "0m", "2w", "1constructor"]) {
		expect(triggerTooltip({ type: "schedule", every }, null)).toBe(
			`Runs every ${every}`
		);
	}
	expect(triggerTooltip({ type: "schedule", cron: "0 5 * * *" }, null)).toBe(
		"Cron: 0 5 * * *"
	);
});
