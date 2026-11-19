import { RYU_ENGINE_ID } from "../../core/agentIdentity.ts";
import { type CliTranslator, tf, tr, trMessage } from "../../i18n/translate.ts";

/** What the editor knows about a save Core's launch check refused. */
export interface LaunchRefusal {
	agentId: string;
	engine: string | null;
	identityMode: string;
	isNew: boolean;
	reason: string | null | undefined;
}

type Translator = Pick<CliTranslator, "tf" | "tr" | "trMessage">;

/**
 * The editor's error for a refused launch check, as whole translated
 * sentences: Core's reason (catalogued templates translated, other text kept),
 * "Nothing was saved.", then how to fix it. Mirrors `ryu-cli agents create`.
 */
export function launchRefusalMessage(
	refusal: LaunchRefusal,
	translator: Translator = { tf, tr, trMessage }
): string {
	const reason =
		refusal.reason == null
			? translator.tr("Core says this agent's engine would not start.")
			: translator.trMessage(refusal.reason);
	const hint = refusalHint(refusal, translator);
	return `${reason} ${translator.tr("Nothing was saved.")}${hint}`;
}

function refusalHint(refusal: LaunchRefusal, translator: Translator): string {
	if (refusal.engine === RYU_ENGINE_ID) {
		return "";
	}
	if (refusal.isNew) {
		return ` ${translator.tf("Set the engine to {engineId} to run it on Ryu instead.", { engineId: RYU_ENGINE_ID })}`;
	}
	const command = `ryu-cli agents identity ${refusal.agentId} ${refusal.identityMode} --engine ${RYU_ENGINE_ID}`;
	return ` ${translator.tf("Change how it works or its account access, or switch its engine with '{command}'.", { command })}`;
}
