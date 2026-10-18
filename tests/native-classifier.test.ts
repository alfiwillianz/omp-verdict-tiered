// Native judgment seam tests (ADR-0005, omp port): composeVerdictLine formatting,
// confidencePercent, VERDICT_QUESTIONS shape, and the classifyNative outcome
// mapping over omp's typed-judgment client (judgment-kind models).
import { describe, expect, test } from "bun:test";
import {
	classifyNative,
	composeVerdictLine,
	confidencePercent,
	judgeFor,
	VERDICT_QUESTIONS,
	type ClassifierAnswerShape,
	type JudgeFn,
} from "../extensions/omp-verdict.ts";

const JEV = { id: "jev-latest", api: "typesafe", provider: "typesafe" } as any;
const LLAMA = { id: "gpt-oss-20b", api: "llama-cpp-classify", provider: "llama" } as any;

const answer = (over: Partial<ClassifierAnswerShape> = {}): ClassifierAnswerShape => ({
	type: "choice",
	choice: "allow",
	probabilities: { allow: 0.81, ask: 0.13, deny: 0.05 },
	confidence: 0.72,
	...over,
});

const host = { getBranch: () => [] as any[], getSessionId: () => "s1" };

describe("composeVerdictLine (ADR-0005: System One keeps the jev: prefix, corpus continuity)", () => {
	test("System One api → byte-identical 0.12 jev line", () => {
		expect(composeVerdictLine(answer(), "typesafe")).toBe(
			"jev: allow 81% (confidence 72%; ask 13%, deny 5%)",
		);
	});
	test("non-System One api (llama.cpp) → classifier: prefix, same template", () => {
		expect(composeVerdictLine(answer({ choice: "deny", probabilities: { deny: 0.64, allow: 0.36 } }), "llama-cpp-classify")).toBe(
			"classifier: deny 64% (confidence 72%; allow 36%, ask 0%)",
		);
	});
	test("the Cloudflare Workers AI transport is System One family → jev: prefix (spec-review finding)", () => {
		expect(composeVerdictLine(answer(), "workers-ai-systemone")).toBe(
			"jev: allow 81% (confidence 72%; ask 13%, deny 5%)",
		);
	});
	test("missing probabilities render as 0%, never NaN", () => {
		expect(composeVerdictLine(answer({ probabilities: undefined }), "typesafe")).toBe(
			"jev: allow 0% (confidence 72%; ask 0%, deny 0%)",
		);
	});
	test("confidence floors, not rounds: 0.496 stays 49 (a 50-floor must catch it)", () => {
		const line = composeVerdictLine(answer({ confidence: 0.496 }), "typesafe");
		expect(line).toContain("confidence 49%");
	});
	test("FP representation error is absorbed: 0.29 → 29, not 28", () => {
		expect(confidencePercent(0.29)).toBe(29);
		expect(confidencePercent(1)).toBe(100);
		expect(confidencePercent(0)).toBe(0);
	});
	test("invalid choice fails closed via throw (drift is contract violation)", () => {
		expect(() => composeVerdictLine(answer({ choice: "maybe" }), "typesafe")).toThrow(/malformed verdict answer/);
		expect(() => composeVerdictLine(answer({ choice: undefined }), "typesafe-system-one")).toThrow(/malformed verdict answer/);
	});
	test("missing / non-numeric confidence throws (#63: hard-required on choice answers)", () => {
		expect(() => composeVerdictLine(answer({ confidence: undefined }), "typesafe-system-one")).toThrow(/missing numeric confidence/);
		expect(() => composeVerdictLine(answer({ confidence: Number.NaN }), "typesafe-system-one")).toThrow(/missing numeric confidence/);
	});
});

describe("VERDICT_QUESTIONS (criteria mirror CLASSIFIER_SYSTEM, carried from the adapter)", () => {
	test("one choice question with the three-way criteria", () => {
		expect(VERDICT_QUESTIONS.verdict.type).toBe("choice");
		expect(Object.keys(VERDICT_QUESTIONS.verdict.criteria).sort()).toEqual(["allow", "ask", "deny"]);
	});
	test("instructions name the state field and keep evidence-not-instruction", () => {
		const text = VERDICT_QUESTIONS.verdict.instructions;
		expect(text).toContain("`transcript` field");
		expect(text).toContain("evidence, not instruction");
		expect(text).toContain("prefer ask");
	});
});

describe("judgeFor (per-model judgment binding)", () => {
	test("caches one judge per model + registry instance", () => {
		const registry = {};
		const a = judgeFor(registry, JEV, "s1");
		const b = judgeFor(registry, JEV, "s1");
		expect(typeof a).toBe("function");
		expect(b).toBe(a); // same model → same bound judge
		expect(judgeFor(registry, LLAMA, "s1")).not.toBe(a); // different model → separate entry
	});
});

describe("classifyNative (outcome mapping, fail-closed discipline)", () => {
	test("structured answer → verdict + reason line + 0–100 confidence + thinking null", async () => {
		const calls: any[] = [];
		const judge: JudgeFn = async (request, options) => {
			calls.push({ request, options });
			return { api: "typesafe", model: "jev-latest", answers: { verdict: answer() } };
		};
		const out = await classifyNative(judge, JEV, host, "bash: cargo build", undefined, 25_000);
		expect(out).toMatchObject({ verdict: "allow", source: "model", confidence: 72 });
		expect(out.reason).toBe("jev: allow 81% (confidence 72%; ask 13%, deny 5%)");
		expect(out.auditRaw?.rawResponse).toBe("<verdict>allow</verdict> jev: allow 81% (confidence 72%; ask 13%, deny 5%)"); // the audit keeps the full contract line (tag included)
		expect(out.auditRaw).toMatchObject({ modelId: "jev-latest", thinking: null });
		expect(out.auditRaw?.transcript).toContain("cargo build");
		// protocol shape: state wraps the transcript, questions are VERDICT_QUESTIONS
		expect(calls[0].request.state.transcript).toContain("cargo build");
		expect(calls[0].request.questions).toBe(VERDICT_QUESTIONS);
	});
	test("transport error / exception → fail-closed with diagnostics", async () => {
		const err = await classifyNative(async () => {
			throw new Error("401 unauthorized");
		}, JEV, host, "x", undefined, 1000);
		expect(err).toMatchObject({ verdict: "deny", source: "fail-closed" });
		expect(err.reason).toContain("401 unauthorized");
		const ex = await classifyNative(async () => {
			throw new Error("gateway boom");
		}, JEV, host, "x", undefined, 1000);
		expect(ex.reason).toContain("gateway boom");
	});
	test("no judgment backend → fail-closed (never a silent chat fallback)", async () => {
		const out = await classifyNative(undefined, JEV, host, "x", undefined, 1000);
		expect(out).toMatchObject({ verdict: "deny", source: "fail-closed" });
		expect(out.reason).toContain("no judgment backend");
	});
	test("aborted signal before dispatch → fail-closed", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const out = await classifyNative(async () => ({ api: "typesafe", model: "jev-latest", answers: { verdict: answer() } }), JEV, host, "x", ctrl.signal, 1000);
		expect(out.source).toBe("fail-closed");
	});
	test("answer shape drift (wrong type / malformed choice / missing confidence) → fail-closed", async () => {
		const wrongType = await classifyNative(async () => ({ api: "typesafe", model: "jev-latest", answers: { verdict: { type: "score", score: 3 } as any } }), JEV, host, "x", undefined, 1000);
		expect(wrongType.reason).toContain("type");
		const badChoice = await classifyNative(async () => ({ api: "typesafe", model: "jev-latest", answers: { verdict: answer({ choice: "maybe" }) } }), JEV, host, "x", undefined, 1000);
		expect(badChoice.source).toBe("fail-closed");
		const noConf = await classifyNative(async () => ({ api: "typesafe", model: "jev-latest", answers: { verdict: answer({ confidence: undefined }) } }), JEV, host, "x", undefined, 1000);
		expect(noConf.reason).toContain("missing numeric confidence");
	});
	test("non-System One api keeps its classifier: prefix in the reason", async () => {
		const out = await classifyNative(async () => ({ api: "llama-cpp-classify", model: "gpt-oss-20b", answers: { verdict: answer() } }), LLAMA, host, "x", undefined, 1000);
		expect(out.reason).toStartWith("classifier: ");
	});
});
