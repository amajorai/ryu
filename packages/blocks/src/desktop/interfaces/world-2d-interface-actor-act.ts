import {
	type InterfaceAgentAct,
	waitBand,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import { toolForActivity } from "./game3d-acts.ts";
import type { World2dTool } from "./world-2d-act-sprites.ts";
import type { ActorAct } from "./world-2d-render.ts";

/** The kit's tools the 2D village draws (others hold nothing). */
const WORLD_2D_TOOLS = new Set<string>([
	"book",
	"clipboard",
	"globe",
	"lens",
	"quill",
	"wrench",
]);

function parseIso(iso: string | null | undefined): number | null {
	const value = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(value) ? value : null;
}

/** What a villager's act draws over its sprite (world-2d-render `ActorAct`). */
export function actorAct(
	act: InterfaceAgentAct,
	nowMs: number,
	/** `minimal` (the "Overlay density" setting) drops pips, "~" and the next sign. */
	density: "full" | "minimal" = "full"
): ActorAct {
	const minimal = density === "minimal";
	const ask = act.act === "asking" ? act.ask : null;
	let carry: ActorAct["carry"] = null;
	if (act.carry === "approval") {
		carry = "letter";
	} else if (act.carry === "question") {
		carry = "scroll";
	}
	const tool =
		act.act === "working" ? toolForActivity(act.carry ?? null) : undefined;
	return {
		// One lamp per counted failure (an interruption has its flag, a
		// rate limit its zzz), and a dim one per failure too old to count.
		alarms: act.blockers.filter(
			(blocker) =>
				blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
		).length,
		back:
			act.act === "limited"
				? (/back (.+)$/.exec(act.bubble?.text ?? "")?.[1] ?? null)
				: null,
		carry: ask ? carry : null,
		followers: act.helpers?.running ?? 0,
		next: !minimal && act.next !== null,
		oldAlarms: act.pending.old,
		tool: tool && WORLD_2D_TOOLS.has(tool) ? (tool as World2dTool) : null,
		waitTint: ask
			? waitBand(parseIso(ask.since), nowMs, parseIso(ask.expiresAt))
			: undefined,
		failed:
			act.act === "blocked" &&
			act.blockers.some((blocker) => blocker.kind !== "interrupted"),
		interrupted:
			act.blockers.some((blocker) => blocker.kind === "interrupted") &&
			!act.blockers.some(
				(blocker) =>
					blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
			),
		suggestion: act.suggestions.length > 0,
		unread: act.pending.unread > 0,
		limited: act.act === "limited",
		// Steps the agent reported (plan or workflow) as pips; a routine's
		// estimate is only a "~", never guessed steps.
		estimate:
			!minimal && act.act === "working" && act.progress?.kind === "estimate",
		pips:
			!minimal &&
			act.act === "working" &&
			(act.progress?.kind === "plan" || act.progress?.kind === "workflow") &&
			act.progress.total > 0
				? { done: act.progress.done, total: act.progress.total }
				: null,
		wait: ask
			? waitLabel(ask.since, nowMs, {
					approx: ask.sinceApprox,
					until: ask.expiresAt ?? null,
					untilApprox: ask.expiresApprox,
				})
			: null,
	};
}
