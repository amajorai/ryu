// Human-readable rendering of a Ryu Connect refusal for `ryu-cli connect`.

import { tf } from "../i18n/translate.ts";
import type { ConnectError } from "./connectClient.ts";
import type { CliContext } from "./types.ts";

/** Render a refusal with what to do next; exit 1. */
export function refusal(ctx: CliContext, error: ConnectError): number {
	if (ctx.flags.json) {
		ctx.io.err(
			`${JSON.stringify({
				...error.body,
				error: error.message,
				code: error.code,
				status: error.status,
			})}\n`
		);
		return 1;
	}
	const lines = [`Error: ${error.message}`];
	const body = error.body;
	if (Array.isArray(body.didYouMean) && body.didYouMean.length > 0) {
		lines.push(tf("Did you mean: {ids}", { ids: body.didYouMean.join(", ") }));
	}
	if (typeof body.top_up_url === "string") {
		lines.push(tf("Add credit: {url}", { url: body.top_up_url }));
	}
	if (
		body.precondition !== null &&
		typeof body.precondition === "object" &&
		"toolkit" in body.precondition
	) {
		lines.push(
			tf(
				"Connect the {toolkit} account (in Ryu, from Integrations), then run the same call again.",
				{ toolkit: String(body.precondition.toolkit) }
			)
		);
	}
	if (error.retryAfterSeconds !== null) {
		lines.push(
			tf("Retry after {seconds} s.", {
				seconds: String(error.retryAfterSeconds),
			})
		);
	}
	ctx.io.err(`${lines.join("\n")}\n`);
	return 1;
}
