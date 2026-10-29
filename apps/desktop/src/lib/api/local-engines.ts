// apps/desktop/src/lib/api/local-engines.ts
//
// Local inference engines, mirroring Core's `LOCAL_ENGINES`
// (`apps/core/src/sidecar/active_engine.rs`). Core treats an agent bound to one
// of these as local: it routes to a loopback URL (`agent-egress.ts`) and its
// turns read the `context.max-tokens.local` / `.engine.<id>` budget overrides
// (`preferences.ts`). `local-engines.test.ts` pins this list to Core's.
//
// Deliberately NOT `inference.ts`'s `LOCAL_ENGINES`: that set is the narrower
// "engines whose endpoint accepts the non-standard sampler fields".

export const CORE_LOCAL_ENGINES: readonly string[] = [
	"llamacpp",
	"ollama",
	"lemonade",
	"magnitude",
	"llama-swap",
	"freetoken",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
	"mlx-serve",
	"omlx",
	"docker-model-runner",
	"apfel",
	"mesh-llm",
];
