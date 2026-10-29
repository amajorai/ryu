import type { Session } from "@ryuhq/core-client/sessions";
import type { Team } from "@ryuhq/core-client/teams";
import type { AcpPickerChoice } from "../../core/acpPicker.ts";
import type {
	ChatPermission,
	PermissionToolDetail,
} from "../../core/chatPermission.ts";
import type {
	ChatQuestion,
	ChatQuestionAnswer,
} from "../../core/chatQuestion.ts";
import type { TurnUsage } from "../../core/chatStream.ts";
import type { ChatPart } from "../../core/chatTranscript.ts";
import type { ModelPickerChoice } from "../../core/modelPicker.ts";

type Role = "user" | "assistant";

/** Who answered a finished assistant turn and how long it took. Stamped
 * once the turn completes; a streaming or failed turn has none. */
interface TurnReceipt {
	agentLabel?: string;
	elapsedMs: number;
	modelLabel?: string;
}

export interface Message {
	content: string;
	id: number;
	/** Set when Esc cut this assistant turn off; kept in memory only. */
	interrupted?: boolean;
	parts: ChatPart[];
	receipt?: TurnReceipt;
	role: Role;
	/** Latest usage snapshot Core streamed for this assistant turn. */
	usage?: TurnUsage;
}

export type Overlay =
	| { kind: "none" }
	| { kind: "agents"; agents: { id: string; name: string }[]; index: number }
	| {
			kind: "teams";
			teams: Team[];
			index: number;
			loading: boolean;
			error: string | null;
	  }
	| { kind: "models"; choices: ModelPickerChoice[]; index: number }
	| { kind: "acp"; choices: AcpPickerChoice[]; index: number }
	| { kind: "sessions"; sessions: Session[] }
	| { kind: "btw"; question: string; answer: string | null }
	| {
			kind: "permission";
			permission: ChatPermission;
			detail: PermissionToolDetail;
			index: number;
	  }
	| {
			kind: "question";
			question: ChatQuestion;
			questionIndex: number;
			selected: number;
			answers: ChatQuestionAnswer[];
			text: string;
	  }
	| { kind: "delete"; conversationId: string }
	| { kind: "help"; command?: string }
	| { kind: "queue"; index: number }
	| { kind: "theme"; argument?: string }
	| { kind: "plugin_note"; notes: string[] };
