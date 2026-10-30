// Context, hardware, idle-unloading, and continuous-batching field groups for
// ModelLaunchConfigSection.

import type { LaunchConfig } from "@/src/lib/api/inference.ts";
import {
	BoolField,
	EnumField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "./fields.tsx";
import type { LaunchFieldsApi } from "./ModelLaunchConfigSection-rules.ts";

export function LaunchContextHardwareGroup({
	fields: { bool, num, set, setNumber, str },
	llamaCppEngine,
	meshLlmEngine,
	mlxServeEngine,
	ollamaEngine,
	sglangEngine,
	vllmEngine,
	whisperEngine,
}: {
	fields: LaunchFieldsApi;
	llamaCppEngine: boolean;
	meshLlmEngine: boolean;
	mlxServeEngine: boolean;
	ollamaEngine: boolean;
	sglangEngine: boolean;
	vllmEngine: boolean;
	whisperEngine: boolean;
}) {
	return (
		<>
			{llamaCppEngine ||
			vllmEngine ||
			sglangEngine ||
			whisperEngine ||
			ollamaEngine ||
			mlxServeEngine ||
			meshLlmEngine ? (
				<FieldGroup title="Context & hardware">
					<FieldGrid>
						{llamaCppEngine ||
						vllmEngine ||
						sglangEngine ||
						ollamaEngine ||
						mlxServeEngine ||
						meshLlmEngine ? (
							<NumberField
								hint={
									llamaCppEngine || mlxServeEngine || meshLlmEngine
										? "--ctx-size"
										: ollamaEngine
											? "Modelfile PARAMETER num_ctx"
											: vllmEngine
												? "--max-model-len"
												: "--context-length"
								}
								label="Context size"
								min={0}
								onChange={(v) => setNumber("ctx_size", v)}
								step={512}
								value={num("ctx_size")}
							/>
						) : null}
						{meshLlmEngine ? (
							<NumberField
								hint="--parallel: concurrent sequences per served model."
								label="Parallel lanes"
								min={1}
								onChange={(v) => setNumber("parallel", v)}
								step={1}
								value={num("parallel")}
							/>
						) : null}
						{llamaCppEngine || ollamaEngine ? (
							<>
								<NumberField
									hint={
										ollamaEngine
											? "Modelfile PARAMETER num_gpu"
											: "-ngl (-1 = all to GPU)"
									}
									label="GPU layers"
									min={-1}
									onChange={(v) => setNumber("gpu_layers", v)}
									step={1}
									value={num("gpu_layers")}
								/>
								<NumberField
									hint={
										ollamaEngine ? "Modelfile PARAMETER num_batch" : undefined
									}
									label="Batch size"
									onChange={(v) => setNumber("batch_size", v)}
									step={1}
									value={num("batch_size")}
								/>
								{llamaCppEngine ? (
									<NumberField
										label="uBatch size"
										onChange={(v) => setNumber("ubatch_size", v)}
										step={1}
										value={num("ubatch_size")}
									/>
								) : null}
								<NumberField
									hint={
										ollamaEngine ? "Modelfile PARAMETER num_thread" : undefined
									}
									label="Threads"
									onChange={(v) => setNumber("threads", v)}
									step={1}
									value={num("threads")}
								/>
								{llamaCppEngine ? (
									<>
										<EnumField
											label="Flash attention"
											onChange={(v) =>
												set(
													"flash_attn",
													/* SAFETY: This private EnumField mounts only auto/on/off, and its Default sentinel publishes undefined. These are exactly the optional flash_attn values; no stored launch configuration is validated by this cast. */ v as LaunchConfig["flash_attn"]
												)
											}
											options={[
												{ value: "auto", label: "Auto" },
												{ value: "on", label: "On" },
												{ value: "off", label: "Off" },
											]}
											value={str("flash_attn")}
										/>
										<TextField
											hint="KV cache type, e.g. q8_0, f16"
											label="Cache type K"
											onChange={(v) => set("cache_type_k", v)}
											value={str("cache_type_k")}
										/>
										<TextField
											label="Cache type V"
											onChange={(v) => set("cache_type_v", v)}
											value={str("cache_type_v")}
										/>
									</>
								) : null}
							</>
						) : null}
						{whisperEngine ? (
							<NumberField
								label="Threads"
								onChange={(v) => setNumber("threads", v)}
								step={1}
								value={num("threads")}
							/>
						) : null}
						{llamaCppEngine || ollamaEngine ? (
							<div className="col-span-full flex flex-col gap-1">
								<BoolField
									hint={
										ollamaEngine
											? "Modelfile PARAMETER use_mlock"
											: "Lock the model into RAM (--mlock)"
									}
									label="Lock in RAM"
									onChange={(v) => set("mlock", v)}
									value={bool("mlock")}
								/>
								<BoolField
									hint={
										ollamaEngine
											? "Modelfile PARAMETER use_mmap false"
											: "Disable memory-mapping (--no-mmap)"
									}
									label="No mmap"
									onChange={(v) => set("no_mmap", v)}
									value={bool("no_mmap")}
								/>
							</div>
						) : null}
					</FieldGrid>
				</FieldGroup>
			) : null}
		</>
	);
}

export function LaunchBatchingGroups({
	fields: { bool, num, set, setNumber },
	llamaCppEngine,
}: {
	fields: LaunchFieldsApi;
	llamaCppEngine: boolean;
}) {
	return (
		<>
			{llamaCppEngine ? (
				<FieldGroup
					description="Release the model and KV cache after an idle period."
					title="Idle unloading"
				>
					<NumberField
						hint="--sleep-idle-seconds; 0 disables the timer"
						label="Unload after idle (seconds)"
						min={0}
						onChange={(value) => setNumber("sleep_idle_secs", value)}
						step={1}
						value={num("sleep_idle_secs")}
					/>
				</FieldGroup>
			) : null}

			{llamaCppEngine ? (
				<FieldGroup
					description="Batch multiple requests in one decode loop (llama.cpp). More slots ⇒ higher throughput for Ryu's fan-out (delegate / threads / teams), sharing KV-cache memory across slots. Leave slots blank for a memory-aware default."
					title="Continuous batching"
				>
					<FieldGrid>
						<NumberField
							hint="--parallel: server slots = batch width. Blank ⇒ auto by memory."
							label="Parallel slots"
							min={1}
							onChange={(v) => setNumber("parallel", v)}
							step={1}
							value={num("parallel")}
						/>
						<NumberField
							hint="--cache-reuse: min prefix KV chunk reused across requests (0 = off)"
							label="Cache reuse"
							min={0}
							onChange={(v) => setNumber("cache_reuse", v)}
							step={64}
							value={num("cache_reuse")}
						/>
					</FieldGrid>
					<div className="flex flex-col gap-1">
						<BoolField
							hint="--kv-unified: one shared KV buffer across slots (avoids the per-slot context split). Auto-on with multiple slots."
							label="Unified KV cache"
							onChange={(v) => set("kv_unified", v)}
							value={bool("kv_unified")}
						/>
						<BoolField
							hint="Continuous batching is ON by default; turn off to emit --no-cont-batching"
							label="Continuous batching"
							onChange={(v) => set("cont_batching", v)}
							value={bool("cont_batching")}
						/>
					</div>
				</FieldGroup>
			) : null}
		</>
	);
}
