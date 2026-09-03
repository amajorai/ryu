import { expect, test } from "bun:test";
import { appStageLayout } from "./pinned-app-stage.tsx";

test("uses a hero for one app, a pair for two, and a three-column grid after that", () => {
	expect(appStageLayout(0)).toBe("hero");
	expect(appStageLayout(1)).toBe("hero");
	expect(appStageLayout(2)).toBe("pair");
	expect(appStageLayout(3)).toBe("grid");
	expect(appStageLayout(12)).toBe("grid");
});
