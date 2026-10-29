import {
	type BrowserLocalRuntime,
	DEFAULT_BROWSER_MODEL_ID,
} from "@ryu/browser-local-ai";
import {
	type AssistantDocReference,
	buildLocalAssistantPrompt,
	deterministicAssistantAnswer,
} from "./docs.ts";
import { runGuestChat } from "./guest-chat.ts";
import { type LocalNodeConfig, runLocalNodeChat } from "./local-node.ts";
import type { AssistantMode } from "./runtime-controls.tsx";

/** One visitor question, routed to the selected runtime. */
export interface AssistantTurn {
	mode: AssistantMode;
	modelReady: boolean;
	/** The connected node, or null when none is connected. */
	node: LocalNodeConfig | null;
	/** Streamed answer so far; the caller ignores it once the turn is superseded. */
	onText: (textSoFar: string) => void;
	question: string;
	references: AssistantDocReference[];
	runtime: Pick<BrowserLocalRuntime, "generate" | "prepare">;
	signal: AbortSignal;
	userContent: string;
}

export interface AssistantTurnResult {
	answer: string;
	notice: string;
}

export function usableBrowserAnswer(answer: string, question: string): boolean {
	const normalized = answer.trim().toLowerCase();
	if (!normalized || normalized.length > 6000) {
		return false;
	}
	const roleLabels = normalized.match(/\b(system|user|assistant):/g) ?? [];
	if (roleLabels.length > 1 || normalized.includes("public context:")) {
		return false;
	}
	return normalized !== question.trim().toLowerCase();
}

function promptMessages(
	turn: AssistantTurn
): Array<{ content: string; role: "system" | "user" }> {
	return [
		{
			content: buildLocalAssistantPrompt(turn.question, turn.references),
			role: "system",
		},
		{ content: turn.userContent, role: "user" },
	];
}

async function runBrowserTurn(
	turn: AssistantTurn
): Promise<AssistantTurnResult> {
	if (!turn.modelReady) {
		await turn.runtime.prepare(DEFAULT_BROWSER_MODEL_ID);
	}
	const result = await turn.runtime.generate(
		{ messages: promptMessages(turn), modelId: DEFAULT_BROWSER_MODEL_ID },
		turn.signal
	);
	const generatedAnswer = result.text.trim();
	const modelAnswerIsUsable = usableBrowserAnswer(
		generatedAnswer,
		turn.question
	);
	return {
		answer: modelAnswerIsUsable
			? generatedAnswer
			: deterministicAssistantAnswer(turn.question, turn.references),
		notice: modelAnswerIsUsable
			? "Answered locally · no prompt was sent to Ryu servers."
			: "Answered locally with public-document grounding.",
	};
}

async function runGuestTurn(turn: AssistantTurn): Promise<AssistantTurnResult> {
	let streamedAnswer = "";
	const answer = await runGuestChat(turn.question, {
		onDelta(delta) {
			streamedAnswer += delta;
			turn.onText(streamedAnswer);
		},
		signal: turn.signal,
	});
	const finalAnswer = answer.trim();
	return {
		answer:
			finalAnswer ||
			deterministicAssistantAnswer(turn.question, turn.references),
		notice: finalAnswer
			? "Answered by Ryu guest chat. Your prompt went through Ryu's screened hosted gateway."
			: "Guest chat returned no text. I answered from Ryu's public docs instead.",
	};
}

async function runNodeTurn(turn: AssistantTurn): Promise<AssistantTurnResult> {
	if (!turn.node) {
		throw new Error("Connect a local Ryu node before sending a question.");
	}
	let streamedAnswer = "";
	const answer = await runLocalNodeChat(turn.node, promptMessages(turn), {
		onDelta(delta) {
			streamedAnswer += delta;
			turn.onText(streamedAnswer);
		},
		signal: turn.signal,
	});
	return {
		answer:
			answer || deterministicAssistantAnswer(turn.question, turn.references),
		notice:
			"Answered by your local Ryu Core node · this visitor turn was not persisted.",
	};
}

/** Runs one turn on the browser model, the guest gateway or the visitor's node. */
export function runAssistantTurn(
	turn: AssistantTurn
): Promise<AssistantTurnResult> {
	if (turn.mode === "browser") {
		return runBrowserTurn(turn);
	}
	if (turn.mode === "guest") {
		return runGuestTurn(turn);
	}
	return runNodeTurn(turn);
}
