import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

test("Companion persistence permission is limited to actual standalone overlay windows", () => {
 const capability = JSON.parse(readFileSync(new URL("./companion-overlay.json", import.meta.url), "utf8"));
 assert.equal(capability.identifier, "companion-overlay");
 assert.deepEqual(capability.windows, ["companion", "companion-overlay"]);
 assert.deepEqual(capability.permissions, ["core:default", "core:window:allow-close", "core:window:allow-set-focus", "store:allow-load", "store:allow-get", "store:allow-set", "store:allow-save"]);
 const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
 const native = readFileSync(new URL("../src/lib.rs", import.meta.url), "utf8");
 assert.match(app, /WINDOW_LABEL === "companion"/);
 assert.match(native, /WebviewWindowBuilder::new\(app, "companion", url\)/);
});
