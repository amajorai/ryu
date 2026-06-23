// "Ask Ryu" — a one-shot question answered by the local Ryu Core, streamed into
// a Detail view. Type the prompt as the command argument.

import {
	Action,
	ActionPanel,
	Detail,
	type LaunchProps,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { streamChat } from "./lib/core";

export default function AskRyu(
	props: LaunchProps<{ arguments: { prompt: string } }>
) {
	const prompt = props.arguments.prompt?.trim() ?? "";
	const [answer, setAnswer] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const startedRef = useRef(false);

	useEffect(() => {
		if (startedRef.current || prompt.length === 0) {
			setIsLoading(false);
			return;
		}
		startedRef.current = true;
		const controller = new AbortController();
		streamChat(
			[{ role: "user", content: prompt }],
			(delta) => setAnswer((prev) => prev + delta),
			{ signal: controller.signal }
		)
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : "Could not reach Ryu Core.")
			)
			.finally(() => setIsLoading(false));
		return () => controller.abort();
	}, [prompt]);

	const markdown =
		prompt.length === 0
			? "Type a question as the command argument."
			: error
				? `**Could not reach Ryu Core.**\n\n${error}\n\nCheck the Core URL in the extension preferences.`
				: `**${prompt}**\n\n${answer || "_Thinking…_"}`;

	return (
		<Detail
			actions={
				<ActionPanel>
					<Action.CopyToClipboard content={answer} title="Copy Answer" />
				</ActionPanel>
			}
			isLoading={isLoading}
			markdown={markdown}
		/>
	);
}
