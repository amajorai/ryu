import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import type { LifePaths } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";
import { type QuizActView, quizContestant } from "./quiz-acts.tsx";
import type { Contestant } from "./quiz-model.ts";
import { STAGE_HEIGHT, STAR_SCALE } from "./quiz-studio-cast.ts";
import { TOWARD } from "./quiz-world.ts";

/** The contestants as villagers at their podiums, acting when on stage. */
export function useQuizStars({
	actOf,
	actView,
	contestants,
	looks,
	paths,
	reducedMotion,
	spots,
	stations,
}: {
	actOf: ReadonlyMap<string, InterfaceAgentAct>;
	actView: QuizActView | null;
	contestants: readonly Contestant[];
	looks: ReadonlyMap<string, MemberLooks>;
	paths: LifePaths | undefined;
	reducedMotion: boolean;
	spots: readonly (readonly [number, number])[];
	stations: ReadonlyMap<string, Vec3>;
}): VillagerSpec[] {
	const tl = useLiteralMessages();
	return useMemo<VillagerSpec[]>(() => {
		const out: VillagerSpec[] = [];
		for (const [index, contestant] of contestants.entries()) {
			const spot = spots[index];
			const base = looks.get(contestant.agent.id);
			const station = stations.get(contestant.agent.id);
			if (!(spot && base && station)) {
				continue;
			}
			const act = actOf.get(contestant.agent.id);
			if (act && actView && paths) {
				const [star, ...helpers] = quizContestant({
					act,
					base: { id: contestant.agent.id, position: station },
					label: "Ask the final question.",
					looks: base,
					paths,
					reduced: reducedMotion,
					view: actView,
				});
				if (star) {
					out.push({ ...star, scale: STAR_SCALE }, ...helpers);
				}
				continue;
			}
			const { agent, score, working } = contestant;
			out.push({
				id: agent.id,
				label: tl(
					"Ask {name} the final question. {working, select, true {Working} other {Idle}}, {score, plural, one {{scoreText} message} other {{scoreText} messages}}.",
					{
						name: agent.name,
						score,
						scoreText: String(score),
						working: working ? "true" : "false",
					}
				),
				looks: base,
				name: agent.name,
				pose: working ? "working" : "idle",
				position: [
					spot[0] - TOWARD[0] * 0.8,
					STAGE_HEIGHT,
					spot[1] - TOWARD[1] * 0.8,
				],
				scale: STAR_SCALE,
			});
		}
		return out;
	}, [
		actOf,
		actView,
		contestants,
		looks,
		paths,
		reducedMotion,
		spots,
		stations,
		tl,
	]);
}
