import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
	discoverSettingsConfigs,
	runSettingsE2e,
} from "./test-settings-e2e.mjs";

const fixtures = [];
afterEach(() => {
	for (const root of fixtures.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ryu-settings-runner-test-"));
	fixtures.push(root);
	mkdirSync(join(root, "e2e"));
	const pool = join(root, "pool");
	const log = join(root, "effects.jsonl");
	const cliPath = join(root, "fixture-cli.cjs");
	writeFileSync(
		cliPath,
		`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const config = args.find(arg => arg.startsWith('--config=')).slice(9);
const output = args.find(arg => arg.startsWith('--output=')).slice(9);
const behavior = JSON.parse(fs.readFileSync(config, 'utf8'));
const marker = fs.readFileSync(path.join(process.env.FIXTURE_POOL, 'execution/owner.txt'), 'utf8');
if (!marker.includes('kind=browser')) throw Error('Browser lease absent');
const lock = path.join(process.cwd(), 'child-active');
fs.writeFileSync(lock, config, {flag:'wx'});
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, 'evidence.txt'), config);
const record = event => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({event, config, output, args})+'\\n');
record('start');
setTimeout(() => {
  record('end');
  fs.unlinkSync(lock);
  if (behavior.signal) process.kill(process.pid, behavior.signal);
  else process.exit(behavior.status || 0);
}, 5);
`
	);
	return {
		root,
		pool,
		log,
		add(name, behavior = {}) {
			const file = join(root, "e2e", name);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify(behavior));
			return file;
		},
		run: () =>
			runSettingsE2e({
				root,
				cliPath,
				environment: { ...process.env, FIXTURE_POOL: pool, FIXTURE_LOG: log },
				resourceOptions: { pool, platform: "linux" },
				outputRoot: root,
				logger: { info() {} },
			}),
		effects: () =>
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
	};
}

test("discovers new settings and tab configs while excluding specs, unrelated configs and dependencies", () => {
	const f = fixture();
	const first = f.add("appearance-settings-proof.playwright.config.ts");
	const second = f.add("nested/billing-tab-proof.playwright.config.mjs");
	f.add("settings.spec.ts");
	f.add("onboarding.playwright.config.ts");
	f.add("node_modules/example-settings.playwright.config.ts");
	assert.deepEqual(discoverSettingsConfigs(f.root), [first, second].sort());
	const added = f.add("new-settings.playwright.config.js");
	assert.deepEqual(
		discoverSettingsConfigs(f.root),
		[first, second, added].sort()
	);
	assert.equal(f.run().results.length, 3);
});

test("executes configs serially under the browser lease with distinct retained artifacts and original defaults", () => {
	const f = fixture();
	f.add("a-settings.playwright.config.ts");
	f.add("b-tab.playwright.config.ts");
	const result = f.run();
	assert.equal(result.exitCode, 0);
	assert.deepEqual(
		f.effects().map(({ event }) => event),
		["start", "end", "start", "end"]
	);
	assert.equal(new Set(result.results.map(({ output }) => output)).size, 2);
	for (const effect of f.effects()) {
		assert.deepEqual(effect.args, [
			"test",
			`--config=${effect.config}`,
			`--output=${effect.output}`,
		]);
		assert.equal(
			readFileSync(join(effect.output, "evidence.txt"), "utf8"),
			effect.config
		);
	}
	assert.equal(existsSync(join(f.pool, "execution")), false);
	assert.notEqual(f.run().outputDirectory, result.outputDirectory);
});

test("nonzero config exits fail the gate and subsequent configs still run", () => {
	const f = fixture();
	f.add("a-settings.playwright.config.ts", { status: 7 });
	f.add("b-tab.playwright.config.ts");
	const result = f.run();
	assert.equal(result.exitCode, 7);
	assert.deepEqual(
		result.results.map(({ status }) => status),
		[7, 0]
	);
	assert.equal(f.effects().length, 4);
	assert.equal(existsSync(join(f.pool, "execution")), false);
});

test("a fixture CLI startup error is reported as failure rather than empty success", () => {
	const f = fixture();
	const broken = f.add("a-settings.playwright.config.ts");
	writeFileSync(broken, "not valid fixture configuration");
	f.add("b-tab.playwright.config.ts");
	const result = f.run();
	assert.equal(result.exitCode, 1);
	assert.deepEqual(
		result.results.map(({ status }) => status),
		[1, 0]
	);
	assert.equal(f.effects().length, 2);
	assert.equal(existsSync(join(f.pool, "execution")), false);
});

test("a terminated child cannot count as success and releases the browser slot", () => {
	const f = fixture();
	f.add("a-settings.playwright.config.ts", { signal: "SIGTERM" });
	f.add("b-tab.playwright.config.ts");
	assert.throws(f.run, /terminated by SIGTERM/);
	assert.equal(f.effects().length, 2);
	assert.equal(existsSync(join(f.pool, "execution")), false);
});

test("an empty config set fails before allocating capacity or launching a child", () => {
	const f = fixture();
	f.add("unrelated.playwright.config.ts");
	assert.throws(f.run, /No desktop settings or tab Playwright configs/);
	assert.equal(existsSync(f.pool), false);
	assert.equal(existsSync(f.log), false);
});

test("occupied test capacity prevents any fixture process and preserves the current owner", () => {
	const f = fixture();
	f.add("a-settings.playwright.config.ts");
	mkdirSync(join(f.pool, "execution"), { recursive: true });
	writeFileSync(join(f.pool, "execution/owner.txt"), "another-browser-owner");
	assert.throws(f.run, /capacity is occupied/);
	assert.equal(existsSync(f.log), false);
	assert.equal(
		readFileSync(join(f.pool, "execution/owner.txt"), "utf8"),
		"another-browser-owner"
	);
});
