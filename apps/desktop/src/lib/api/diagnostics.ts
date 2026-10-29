// apps/desktop/src/lib/api/diagnostics.ts
//
// Typed client for Core's OTLP diagnostics test route
// (`POST /api/diagnostics/otlp/test-span`). Core sends one `ryu.test` span to the
// configured destination and flushes it, so the user can check the endpoint and
// auth headers without waiting for real traffic. Core refuses (409) while
// diagnostics export consent is off or no endpoint is active, so nothing leaves
// the device on refusal; a failed flush is a 502.

import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";

const testSpanResponseSchema = z.object({
	ok: z.literal(true),
	span: z.string(),
	endpoint: z.string(),
});

export type DiagnosticsTestSpanResult =
	| { ok: true; endpoint: string }
	| { ok: false; status: number; message: string };

/** Send one `ryu.test` span to the configured OTLP destination. Core-side
 * refusals and export failures resolve to `{ ok: false }` with Core's message;
 * transport failures (Core unreachable) still throw. */
export async function sendDiagnosticsTestSpan(
	target: ApiTarget
): Promise<DiagnosticsTestSpanResult> {
	try {
		// Parsed below, so an unexpected body is reported rather than thrown.
		const raw = await request(
			target,
			"/api/diagnostics/otlp/test-span",
			{ method: "POST" },
			z.unknown()
		);
		const parsed = testSpanResponseSchema.safeParse(raw);
		if (!parsed.success) {
			return {
				ok: false,
				status: 200,
				message: "Core returned an unexpected test-span response.",
			};
		}
		return { ok: true, endpoint: parsed.data.endpoint };
	} catch (error) {
		if (error instanceof ApiError) {
			return {
				ok: false,
				status: error.status,
				message:
					error.serverMessage ??
					(error.status === 404
						? "This Core is too old to send a test span."
						: `Core answered ${error.status}.`),
			};
		}
		throw error;
	}
}
