// Output control group for AdvancedInferenceSection.

import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { JsonObjectField } from "./AdvancedInferenceSection-json-field.tsx";
import {
	jsonObjectSchema,
	logitBiasSchema,
	type SamplingFieldsProps,
} from "./AdvancedInferenceSection-rules.ts";
import { FieldGroup, TextField } from "./fields.tsx";

/** Output control group: prefill, response format, logit bias, grammar. */
export function SamplingOutputGroup({
	disabled,
	localEngine,
	set,
	shows,
	value,
}: SamplingFieldsProps) {
	return (
		<FieldGroup
			description="Force the shape of the output: prefill the reply, constrain it to JSON or a grammar, or bias individual tokens."
			title="Output control"
		>
			{shows("prefill") ? (
				<TextField
					disabled={disabled}
					hint="Assistant reply is forced to start with this text (e.g. { to force JSON)."
					label="Prefill"
					onChange={(v) => set("prefill", v)}
					value={value.prefill}
				/>
			) : null}
			{shows("response_format") ? (
				<JsonObjectField
					disabled={disabled}
					hint='OpenAI response_format, e.g. {"type":"json_object"} or a json_schema block.'
					id="sampling-response-format"
					label="Response format (JSON)"
					onChange={(v) => set("response_format", v)}
					placeholder={'{\n  "type": "json_object"\n}'}
					schema={jsonObjectSchema}
					value={value.response_format}
				/>
			) : null}
			{shows("logit_bias") ? (
				<JsonObjectField
					disabled={disabled}
					hint="Token-id to bias (~ -100..100). -100 bans a token, +100 forces it."
					id="sampling-logit-bias"
					label="Logit bias (JSON)"
					onChange={(v) => set("logit_bias", v)}
					placeholder={'{\n  "50256": -100\n}'}
					schema={logitBiasSchema}
					value={value.logit_bias}
				/>
			) : null}
			{shows("grammar", localEngine) ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="sampling-grammar">Grammar (GBNF, llama.cpp)</Label>
					<Textarea
						className="min-h-20"
						disabled={disabled}
						id="sampling-grammar"
						onChange={(e) =>
							set("grammar", e.target.value === "" ? undefined : e.target.value)
						}
						placeholder={'root ::= "yes" | "no"'}
						value={value.grammar ?? ""}
						variant="code-caption"
					/>
					<p className="text-muted-foreground text-xs">
						Constrains decoding to a GBNF grammar. llama.cpp only.
					</p>
				</div>
			) : null}
		</FieldGroup>
	);
}
