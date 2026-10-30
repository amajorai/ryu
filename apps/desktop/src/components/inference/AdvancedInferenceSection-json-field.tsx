// Validated JSON-object editor used by AdvancedInferenceSection.

import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useState } from "react";
import type { z } from "zod";
import type { SamplingConfig } from "@/src/lib/api/inference.ts";
import type { jsonObjectSchema } from "./AdvancedInferenceSection-rules.ts";

/**
 * A validated JSON-object editor (used for response_format and logit_bias).
 * Empty text clears the field; invalid or non-object JSON shows an inline error
 * and leaves the last valid value in place. Mirrors the raw-passthrough editor.
 */
export function JsonObjectField<
	TValue extends z.infer<typeof jsonObjectSchema>,
>({
	id,
	label,
	hint,
	placeholder,
	value,
	onChange,
	disabled,
	schema,
}: {
	id: string;
	label: string;
	hint?: string;
	placeholder?: string;
	value: SamplingConfig["response_format"];
	onChange: (v: TValue | undefined) => void;
	disabled?: boolean;
	schema: z.ZodType<TValue>;
}) {
	const [text, setText] = useState<string>(() =>
		value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ""
	);
	const [error, setError] = useState<string | null>(null);

	const handle = (next: string) => {
		setText(next);
		if (next.trim() === "") {
			setError(null);
			onChange(undefined);
			return;
		}
		try {
			const parsed = schema.safeParse(JSON.parse(next));
			if (!parsed.success) {
				setError(parsed.error.issues[0]?.message ?? "Must be a JSON object");
				return;
			}
			setError(null);
			onChange(parsed.data);
		} catch {
			setError("Invalid JSON");
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				aria-invalid={Boolean(error)}
				className="min-h-20"
				disabled={disabled}
				id={id}
				onChange={(e) => handle(e.target.value)}
				placeholder={placeholder}
				value={text}
				variant="code-caption"
			/>
			{error ? (
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			{hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
		</div>
	);
}
