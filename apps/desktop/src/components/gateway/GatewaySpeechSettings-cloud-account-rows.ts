import type { LiteralMessage } from "@ryu/i18n/react";
import type { CloudSpeechAccounts } from "@/src/lib/api/cloud-speech-accounts.ts";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";

/** One provider's summary row in "Cloud speech connections". */
export interface CloudSpeechSummaryRow {
	context: string;
	count: number;
	id: "google-tts" | "polly";
	label: string;
}

/**
 * The provider summary rows, with each context line worded as a whole
 * catalogued sentence. A provider shows once it is configured or has saved
 * accounts; `region` is the form's region, used before Core reports one.
 */
export function cloudSpeechSummaryRows(
	{
		providers,
		region,
		view,
	}: {
		providers: GatewayProvidersConfig | null;
		region: string;
		view: CloudSpeechAccounts | null;
	},
	tl: LiteralMessage
): CloudSpeechSummaryRow[] {
	const rows: CloudSpeechSummaryRow[] = [];
	if (providers?.google_tts || view?.googleTts.length) {
		rows.push({
			context: tl("Supplied OAuth tokens and quota project"),
			count:
				view?.googleTts.length ?? providers?.google_tts?.account_count ?? 0,
			id: "google-tts",
			label: "Google Cloud Text-to-Speech",
		});
	}
	if (providers?.polly || view?.polly.accounts.length) {
		rows.push({
			context: tl("Explicit AWS credentials · {region}", {
				region: view?.polly.region ?? providers?.polly?.region ?? region,
			}),
			count:
				view?.polly.accounts.length ?? providers?.polly?.account_count ?? 0,
			id: "polly",
			label: "Amazon Polly",
		});
	}
	return rows;
}
