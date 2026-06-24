#!/usr/bin/env bun
/**
 * A typed Ryu tool (Runnable, kind: "tool").
 *
 * `defineTool` validates the input against a JSON Schema before your `run` is
 * called, so the model can't pass malformed arguments. Tools need no model — they
 * are deterministic functions an agent or workflow can call.
 *
 * Run:  bun run examples/tool/calculator.ts
 */

import { defineTool } from "@ryu/sdk";

export const calculator = defineTool<{ a: number; op: string; b: number }, number>({
  id: "tool-calculator",
  name: "Calculator",
  schema: {
    type: "object",
    properties: {
      a: { type: "number" },
      op: { type: "string", enum: ["+", "-", "*", "/"] },
      b: { type: "number" },
    },
    required: ["a", "op", "b"],
  },
  run(input) {
    switch (input.op) {
      case "+":
        return Promise.resolve(input.a + input.b);
      case "-":
        return Promise.resolve(input.a - input.b);
      case "*":
        return Promise.resolve(input.a * input.b);
      case "/":
        if (input.b === 0) {
          throw new Error("division by zero");
        }
        return Promise.resolve(input.a / input.b);
      default:
        throw new Error(`unknown op: ${input.op}`);
    }
  },
});

if (import.meta.main) {
  const ctx = { gateway: undefined as never };
  const result = await calculator.run({ a: 6, op: "*", b: 7 }, ctx);
  process.stdout.write(`6 * 7 = ${result}\n`);
}
