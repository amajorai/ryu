import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useId, useState } from "react";

/**
 * A hosted node shows a one-time code in the browser after sign-in and saves
 * the account only when the user who started the connection enters it here.
 */
export function McpOAuthCodeForm({
	appName,
	error,
	onSubmit,
	pending,
}: {
	appName: string;
	error: string | null;
	onSubmit: (code: string) => void;
	pending: boolean;
}) {
	const tl = useLiteralMessages();
	const [code, setCode] = useState("");
	const inputId = useId();
	const typed = code.trim();
	return (
		<form
			className="mt-3 flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (typed.length > 0) {
					onSubmit(typed);
				}
			}}
		>
			<label className="text-muted-foreground text-xs" htmlFor={inputId}>
				{tl("Enter the code your browser shows to finish connecting {name}", {
					name: appName,
				})}
			</label>
			<div className="flex gap-2">
				<Input
					aria-invalid={error ? true : undefined}
					autoComplete="off"
					id={inputId}
					onChange={(event) => setCode(event.target.value)}
					placeholder="ABCD-EFGH"
					size="compact"
					spellCheck={false}
					value={code}
				/>
				<Button
					disabled={pending || typed.length === 0}
					loading={pending}
					size="sm"
					type="submit"
				>
					Finish
				</Button>
			</div>
			{error ? (
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</form>
	);
}
