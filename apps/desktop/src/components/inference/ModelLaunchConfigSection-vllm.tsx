// vLLM / SGLang field group for ModelLaunchConfigSection.

import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	BoolField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "./fields.tsx";
import type { LaunchFieldsApi } from "./ModelLaunchConfigSection-rules.ts";

export function LaunchVllmSglangGroup({
	configOwnerId,
	fields: { bool, num, set, setNumber, str },
	setSpeculativeConfig,
	sglangEngine,
	speculativeConfigError,
	speculativeConfigText,
	vllmEngine,
}: {
	configOwnerId: string;
	fields: LaunchFieldsApi;
	setSpeculativeConfig: (text: string) => void;
	sglangEngine: boolean;
	speculativeConfigError: string | null;
	speculativeConfigText: string;
	vllmEngine: boolean;
}) {
	return (
		<>
			{vllmEngine || sglangEngine ? (
				<FieldGroup
					description="Applied when serving this model with vLLM or SGLang."
					title="vLLM / SGLang"
				>
					<FieldGrid>
						{vllmEngine ? (
							<NumberField
								hint="vLLM 0.0–1.0"
								label="GPU memory utilization"
								max={1}
								min={0}
								onChange={(v) => setNumber("gpu_memory_utilization", v)}
								step={0.05}
								value={num("gpu_memory_utilization")}
							/>
						) : null}
						{sglangEngine ? (
							<NumberField
								hint="SGLang 0.0–1.0"
								label="Mem fraction static"
								max={1}
								min={0}
								onChange={(v) => setNumber("mem_fraction_static", v)}
								step={0.05}
								value={num("mem_fraction_static")}
							/>
						) : null}
						<NumberField
							label="Tensor parallel"
							onChange={(v) => setNumber("tensor_parallel", v)}
							step={1}
							value={num("tensor_parallel")}
						/>
						<TextField
							hint="auto | float16 | bfloat16"
							label="Dtype"
							onChange={(v) => set("dtype", v)}
							value={str("dtype")}
						/>
						<TextField
							hint="awq | gptq | fp8 | …"
							label="Quantization"
							onChange={(v) => set("quantization", v)}
							value={str("quantization")}
						/>
						<TextField
							label="KV cache dtype"
							onChange={(v) => set("kv_cache_dtype", v)}
							value={str("kv_cache_dtype")}
						/>
						{vllmEngine ? (
							<NumberField
								label="Maximum sequences"
								min={1}
								onChange={(v) => setNumber("max_num_seqs", v)}
								step={1}
								value={num("max_num_seqs")}
							/>
						) : null}
						{sglangEngine ? (
							<NumberField
								label="Maximum running requests"
								min={1}
								onChange={(v) => setNumber("max_running_requests", v)}
								step={1}
								value={num("max_running_requests")}
							/>
						) : null}
					</FieldGrid>
					{vllmEngine ? (
						<BoolField
							label="Enable prefix caching"
							onChange={(value) => set("enable_prefix_caching", value)}
							value={bool("enable_prefix_caching")}
						/>
					) : null}
					{vllmEngine ? (
						<>
							<FieldGrid>
								<TextField
									hint="Draft model path from the vLLM speculative config."
									label="Draft model"
									onChange={(v) => set("draft_model", v)}
									value={str("draft_model")}
								/>
								<NumberField
									label="Draft tokens"
									min={1}
									onChange={(v) =>
										setNumber("draft_max", v, {
											label: "Draft tokens",
											min: 1,
										})
									}
									step={1}
									value={num("draft_max")}
								/>
							</FieldGrid>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`launch-speculative-config-${configOwnerId}`}>
									Speculative config (JSON)
								</Label>
								<Textarea
									aria-invalid={Boolean(speculativeConfigError)}
									className="min-h-24"
									id={`launch-speculative-config-${configOwnerId}`}
									onChange={(event) => setSpeculativeConfig(event.target.value)}
									placeholder={'{\n  "num_speculative_tokens": 5\n}'}
									value={speculativeConfigText}
									variant="code-caption"
								/>
								{speculativeConfigError ? (
									<p className="text-status-destructive text-xs" role="alert">
										{speculativeConfigError}
									</p>
								) : null}
							</div>
						</>
					) : null}
				</FieldGroup>
			) : null}
		</>
	);
}
