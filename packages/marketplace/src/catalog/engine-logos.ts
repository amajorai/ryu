// Bundled official engine art. sources.json records upstream provenance.
// Static URL expressions let each host bundle the same assets for offline use.
const ENGINE_LOGOS = new Map<string, string>(
	Object.entries({
		freetoken: new URL("./engine-logos/freetoken-light.svg", import.meta.url)
			.href,
		"llama-swap": new URL("./engine-logos/llama-swap.png", import.meta.url)
			.href,
		llamacpp: new URL("./engine-logos/llamacpp.svg", import.meta.url).href,
		ollama: new URL("./engine-logos/ollama.svg", import.meta.url).href,
		vllm: new URL("./engine-logos/vllm.svg", import.meta.url).href,
		sglang: new URL("./engine-logos/sglang.svg", import.meta.url).href,
		mlx: new URL("./engine-logos/mlx.svg", import.meta.url).href,
		"mlx-serve": new URL("./engine-logos/mlx-serve.png", import.meta.url).href,
		omlx: new URL("./engine-logos/omlx.svg", import.meta.url).href,
		lemonade: new URL("./engine-logos/lemonade.svg", import.meta.url).href,
		"mesh-llm": new URL("./engine-logos/mesh-llm.png", import.meta.url).href,
		sdcpp: new URL("./engine-logos/sdcpp.png", import.meta.url).href,
		microsandbox: new URL("./engine-logos/microsandbox.png", import.meta.url)
			.href,
		opensandbox: new URL("./engine-logos/opensandbox.svg", import.meta.url)
			.href,
		docker: new URL("./engine-logos/docker.svg", import.meta.url).href,
		apple: new URL("./engine-logos/apple.svg", import.meta.url).href,
		ryutts: new URL("./engine-logos/ryutts.svg", import.meta.url).href,
		whispercpp: new URL("./engine-logos/whispercpp.jpeg", import.meta.url).href,
	})
);

const ALIASES = new Map<string, string>(
	Object.entries({
		"mlx-vlm": "mlx",
		"docker-model-runner": "docker",
		apfel: "apple",
	})
);

/** Shared card/hero props; unknown engines retain their deterministic avatar. */
export function engineLogoProps(name: string) {
	const canonical = ALIASES.get(name) ?? name;
	const iconUrl = ENGINE_LOGOS.get(canonical);
	return {
		seedId: `engine:${name}`,
		iconUrl,
		iconUrlDark:
			name === "freetoken"
				? new URL("./engine-logos/freetoken-dark.svg", import.meta.url).href
				: name === "llama-swap"
					? new URL("./engine-logos/llama-swap-dark.png", import.meta.url).href
					: undefined,
		iconPadding: iconUrl ? "sm" : undefined,
		iconAppearance: iconUrl
			? ["ollama", "mlx", "omlx", "apple", "ryutts"].includes(canonical)
				? ("monochrome" as const)
				: ("bare" as const)
			: undefined,
	};
}

export const ENGINE_LOGO_IDS = [...ENGINE_LOGOS.keys()];
