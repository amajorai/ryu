// packages/marketplace/src/catalog/import-tools-action.tsx
//
// Shared by every surface that turns an integrations.sh directory record into
// real tools: the record-level Apps/Plugins catalog rows and the brand-level
// Integrations tab. It lives here rather than inside one section because both
// call the same two Core endpoints with the same success/error contract, and a
// second copy is how the two drift.

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import type { CatalogNode } from "./host.tsx";

/** Core's user-identity header. Mirrors `USER_JWT_HEADER` in
 *  `@ryu/core-client` (this package does not depend on it). */
const USER_JWT_HEADER = "x-ryu-user-jwt";

/** Same admission shape as core-client `makeHeaders`: a managed node has no node
 *  token, so the user JWT is both the Bearer and the identity header. */
function importHeaders(node: CatalogNode): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const userJwt = node.userJwt?.trim() ? node.userJwt : null;
	const bearer = node.token ?? userJwt;
	if (bearer) {
		headers.Authorization = `Bearer ${bearer}`;
	}
	if (userJwt) {
		headers[USER_JWT_HEADER] = userJwt;
	}
	return headers;
}

/** Import an integrations.sh API entry (REST `openapi` or `graphql`) as
 *  gateway-governed `http` tools via the Core import endpoints. Core resolves +
 *  parses server-side and installs a disabled plugin (one tool per operation for
 *  REST, one query tool for GraphQL); the user enables it from Tools to activate. */
export default function ImportToolsAction({
	node,
	endpoint,
	body,
	label = "Add as tools",
	size = "sm",
}: {
	body: Parameters<typeof JSON.stringify>[0];
	endpoint: string;
	/** Verb on the idle button, for surfaces that name the connection instead. */
	label?: string;
	node: CatalogNode;
	size?: "sm" | "default";
}) {
	const tl = useLiteralMessages();
	const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
		"idle"
	);
	const [message, setMessage] = useState<string | null>(null);

	const run = () => {
		setState("busy");
		setMessage(null);
		const base = node.url.replace(/\/$/, "");
		fetch(`${base}${endpoint}`, {
			method: "POST",
			headers: importHeaders(node),
			body: JSON.stringify(body),
		})
			.then(async (res) => {
				// SAFETY: The two mounted catalog callers use Core import_openapi_tools/import_graphql_tool, whose serde JSON success/error branches publish these optional boolean/string/count fields; failed JSON decoding supplies the authored empty object.
				const json = (await res.json().catch(() => ({}))) as {
					dropped?: number;
					error?: string;
					success?: boolean;
					tools?: number;
				};
				if (res.ok && json.success) {
					const toolCount = json.tools ?? 0;
					const toolCountLabel = String(toolCount);
					setMessage(
						json.dropped
							? tl(
									"Added {toolCount, plural, one {{toolCountLabel} tool} other {{toolCountLabel} tools}} ({droppedCount} more not imported). Enable it from Tools to use them.",
									{
										droppedCount: String(json.dropped),
										toolCount,
										toolCountLabel,
									}
								)
							: tl(
									"Added {toolCount, plural, one {{toolCountLabel} tool} other {{toolCountLabel} tools}}. Enable it from Tools to use them.",
									{ toolCount, toolCountLabel }
								)
					);
					setState("done");
				} else {
					setMessage(json.error ?? `HTTP ${res.status}`);
					setState("error");
				}
			})
			.catch((err) => {
				setMessage(err instanceof Error ? err.message : String(err));
				setState("error");
			});
	};

	if (state === "done") {
		return <p className="text-muted-foreground text-sm">{message}</p>;
	}
	return (
		<div className="flex flex-col gap-1">
			<Button disabled={state === "busy"} onClick={run} size={size}>
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				{state === "busy" ? "Adding…" : label}
			</Button>
			{state === "error" && message ? (
				<p className="text-status-destructive text-xs">{message}</p>
			) : null}
		</div>
	);
}
