// test-exempt: data-only fixture for the Rust template drift guard in
// download-label-messages.test.ts. Each pair is a Rust source file and the exact
// English template a DOWNLOAD_LABEL_MESSAGES entry mirrors. It is a fixture so the
// i18n extractor never catalogs these Rust snippets as UI copy.

export const DOWNLOAD_LABEL_MIRRORS: readonly {
	file: string;
	template: string;
}[] = [
	{ file: "apps/core/src/update/apply.rs", template: '"Ryu update ({name})"' },
	{ file: "apps/core/src/update/apply.rs", template: '"Ryu update ({})"' },
	{
		file: "apps/core/src/needle.rs",
		template: '"{} tool and skill router weights"',
	},
	{
		file: "apps/core/src/needle.rs",
		template: '"{label} tool and skill router"',
	},
	{
		file: "apps/core/src/sidecar/manifest_sidecar.rs",
		template: '"app sidecar bundle: {url}"',
	},
	{
		file: "apps/core/src/sidecar/manifest_sidecar.rs",
		template: '"app sidecar: {command}"',
	},
	{
		file: "apps/core/src/sidecar/external_runtime.rs",
		template: '"plugin runtime source: {}"',
	},
	{
		file: "apps/core/src/sidecar/external_runtime.rs",
		template: '"plugin asset: {}"',
	},
	{
		file: "apps/core/src/sidecar/manifest_sidecar_binary.rs",
		template: '"plugin sidecar binary: {}"',
	},
	{
		file: "apps/core/src/sidecar/manifest_sidecar_binary.rs",
		template: '"plugin sidecar archive: {}"',
	},
	{
		file: "apps/core/src/sidecar/providers/llamacpp/downloader.rs",
		template: '"CUDA runtime"',
	},
	{
		file: "apps/core/src/sidecar/providers/audiocpp/downloader.rs",
		template: '"audio.cpp runtime"',
	},
	{
		file: "apps/core/src/sidecar/providers/whispercpp/downloader.rs",
		template: '"whisper.cpp model"',
	},
	{ file: "crates/core/vad/src/lib.rs", template: '"Silero VAD model"' },
	{
		file: "apps/core/src/sidecar/providers/audiocpp/downloader.rs",
		template: '"audio.cpp PocketTTS model"',
	},
	{
		file: "apps/core/src/sidecar/providers/audiocpp/downloader.rs",
		template: '"audio.cpp Alba voice"',
	},
	{
		file: "apps/core/src/sidecar/providers/outetts/downloader.rs",
		template: '"OuteTTS (weights)"',
	},
	{
		file: "apps/core/src/sidecar/providers/ryutts/kokoro.rs",
		template: '"Kokoro 82M (weights)"',
	},
	{
		file: "apps/core/src/sidecar/providers/outetts/downloader.rs",
		template: '"OuteTTS (vocoder)"',
	},
	{
		file: "apps/core/src/sidecar/providers/ryutts/kokoro.rs",
		template: '"Kokoro 82M (voice pack)"',
	},
	{
		file: "apps/core/src/sidecar/providers/llamacpp/downloader.rs",
		template: '"llama.cpp ({})"',
	},
	{
		file: "apps/core/src/sidecar/providers/llamacpp/variant.rs",
		template: '=> "CPU only"',
	},
	{
		file: "apps/core/src/sidecar/providers/llamacpp/variant.rs",
		template: '=> "Apple GPU (Metal)"',
	},
	{
		file: "apps/core/src/sidecar/providers/llamacpp/variant.rs",
		template: '=> "NVIDIA GPU (CUDA)"',
	},
	{
		file: "apps/core/src/sidecar/providers/llamacpp/variant.rs",
		template: '=> "GPU (Vulkan)"',
	},
	{
		file: "apps/core/src/sidecar/providers/ryutts/mod.rs",
		template: '"Ryu Audio sidecar"',
	},
	{
		file: "apps/core/src/sidecar/providers/parakeet/downloader.rs",
		template: '"Parakeet v3 (archive)"',
	},
	{
		file: "apps/core/src/sidecar/providers/sdcpp/downloader.rs",
		template: ' text encoder (Q5_K_M)"',
	},
	{
		file: "apps/core/src/sidecar/providers/sdcpp/downloader.rs",
		template: '"CLIP-vision H image encoder"',
	},
	{
		file: "apps/core/src/sidecar/providers/sdcpp/downloader.rs",
		template: ' vision projector (F16)"',
	},
	{
		file: "apps/core/src/sidecar/providers/sdcpp/downloader.rs",
		template: ' video model (Q8_0)"',
	},
];
