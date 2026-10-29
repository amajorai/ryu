import type { TuitionRequestPayload } from "@ryu/app-host/rpc";
import type {
	Item,
	MasteryReport,
	ReviewCandidate,
	Session,
	Skill,
	Source,
	Subject,
} from "../../../../apps-store/tuition/ui/src/types.ts";

export interface TuitionProofCall extends TuitionRequestPayload {
	method: NonNullable<TuitionRequestPayload["method"]>;
	status: number;
}

export interface TuitionProofState {
	activeSettings: Record<string, number>;
	attempts: Array<{ item_id: string; response: string; session_id: string }>;
	calls: TuitionProofCall[];
	candidates: ReviewCandidate[];
	sessions: Session[];
	skills: Skill[];
	sources: Source[];
	subjects: Subject[];
}

export interface TuitionProofApi {
	calls: () => TuitionProofCall[];
	connected: () => boolean;
	failNext: (method: string, path: string, message: string) => void;
	mount: (input: {
		appHtml: string;
		tab: string;
		grants?: string[];
		readOnly?: boolean;
	}) => void;
	state: () => TuitionProofState;
}

export interface TuitionFixtures {
	activeSettings: Record<string, number>;
	attempts: TuitionProofState["attempts"];
	candidates: ReviewCandidate[];
	items: Item[];
	mastery: MasteryReport;
	sessionProgress: Record<string, number>;
	sessions: Session[];
	skills: Skill[];
	sources: Source[];
	subjects: Subject[];
}
