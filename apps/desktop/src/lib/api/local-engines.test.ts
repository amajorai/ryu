import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_LOCAL_ENGINES } from "./local-engines.ts";

const ACTIVE_ENGINE_RS = "apps/core/src/sidecar/active_engine.rs";
const ANCHOR = "pub const LOCAL_ENGINES: &[&str] = &[";

test("CORE_LOCAL_ENGINES lists exactly Core's LOCAL_ENGINES, in order", () => {
	const source = readFileSync(
		join(import.meta.dir, "../../../../..", ACTIVE_ENGINE_RS),
		"utf8"
	);
	const start = source.indexOf(ANCHOR);
	if (start < 0) {
		throw new Error(`LOCAL_ENGINES is no longer in ${ACTIVE_ENGINE_RS}`);
	}
	const body = source.slice(start + ANCHOR.length, source.indexOf("];", start));
	const listed = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	expect(listed.length).toBeGreaterThan(0);
	expect([...CORE_LOCAL_ENGINES]).toEqual(listed);
});
