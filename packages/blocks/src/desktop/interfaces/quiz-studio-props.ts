import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import type { IslandShape } from "./game3d-island.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import type { RenderQuality } from "./game3d-toon.ts";
import type { MemberLooks } from "./game3d-villager.tsx";
import type { QuizActView } from "./quiz-acts.tsx";
import type { TileHandlers } from "./quiz-board.tsx";
import type { Contestant, QuizBoard, QuizTile } from "./quiz-model.ts";

export interface QuizStudioProps {
	/** The act layer (a snapshot with `asks`); without it, today's studio. */
	acts?: { onStage: readonly InterfaceAgentAct[]; view: QuizActView } | null;
	/** The studio audience in its theatre rows (the "Audience" setting). */
	audience?: boolean;
	board: QuizBoard;
	contestants: readonly Contestant[];
	handlers: TileHandlers;
	/** With acts: each delivered answer's headline, by thread, for its tile. */
	headlines?: ReadonlyMap<string, string>;
	inPlayId: string | null;
	isRevealed: (tile: QuizTile) => boolean;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onAsk: (agentId: string) => void;
	openId: string | null;
	quality: RenderQuality;
	reducedMotion: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
}
