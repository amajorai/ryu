import { expect, test } from "bun:test";
import { isRyuManagedProvider, svglForProvider } from "./provider-brand.tsx";

test("service and model providers use their canonical bundled SVGL brands", () => {
	expect(svglForProvider("vertex Google Vertex AI")).toBe("google-cloud");
	expect(svglForProvider("google-tts Google Cloud TTS")).toBe("google-cloud");
	expect(svglForProvider("github-models GitHub Models")).toEqual({
		light: "github_light",
		dark: "github_dark",
	});
	expect(svglForProvider("github-copilot")).toEqual({
		light: "copilot",
		dark: "copilot_dark",
	});
	expect(svglForProvider("azure-openai")).toBe("azure");
	expect(svglForProvider("google Gemini")).toBe("gemini");
});

test("Ryu-managed rows never show the supplier behind the tier", () => {
	for (const key of [
		"managed Ryu",
		"managed-cloudflare Ryu Fast",
		"managed-bedrock Ryu Frontier",
		"managed-vertex Ryu Vision",
		"managed-openai-credits Ryu Reasoning",
		"managed-anthropic-credits Ryu Code",
	]) {
		expect(isRyuManagedProvider(key)).toBe(true);
		expect(svglForProvider(key)).toBeNull();
	}
	// The suppliers' own BYOK rows keep their marks.
	expect(svglForProvider("bedrock AWS Bedrock")).toEqual({
		light: "aws_light",
		dark: "aws_dark",
	});
	expect(isRyuManagedProvider("openrouter OpenRouter")).toBe(false);
});

test("unknown custom providers do not borrow an unrelated vendor brand", () => {
	expect(svglForProvider("private-custom-service")).toBeNull();
});
