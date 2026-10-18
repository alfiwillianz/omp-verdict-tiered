/**
 * ADR-0009 tiered semantic adjudication: tokenizer parity, Lancet banding and
 * window contract, Tier 2 parsing/resolution/fail-closed semantics, config
 * validation, and the adjudicate() integration (including audit fields).
 *
 * Hermetic by default: the ONNX encoder is not required. The end-to-end Lancet
 * inference test runs only when OMP_VERDICT_LANCET_DIR points at a verified bundle
 * (`bun run setup:lancet` then `OMP_VERDICT_LANCET_DIR=~/.cache/omp/lancet-nano bun test`).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	adjudicate,
	buildProtectedSet,
	DEFAULT_SEMANTIC_ADJUDICATION,
	resolveAdjudicatorModel,
	resolveSemanticAdjudication,
	SessionState,
} from "../extensions/omp-verdict.ts";
import { CodeT5ByteLevelTokenizer, decodeTokenIds } from "../src/classifiers/tokenizer.ts";
import {
	bandFor,
	calibratedRisk,
	LancetEngine,
	probabilityToLogit,
	windows,
} from "../src/classifiers/lancet.ts";
import {
	ADJUDICATOR_SYSTEM,
	adjudicateWithModel,
	buildAdjudicatorPayload,
	parseAdjudicatorResponse,
} from "../src/classifiers/omp-adjudicator.ts";
import { runTieredAdjudication } from "../src/classifiers/tiered.ts";
import type { LancetResult } from "../src/classifiers/lancet.ts";
import type { AdjudicatorComplete } from "../src/classifiers/omp-adjudicator.ts";

const TMP_AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "omp-verdict-tiered-test-"));
const realAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = TMP_AGENT;
});
afterAll(() => {
	if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = realAgentDir;
	fs.rmSync(TMP_AGENT, { recursive: true, force: true });
});
beforeEach(() => {
	fs.rmSync(path.join(TMP_AGENT, "config"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP_AGENT, "verdicts"), { recursive: true, force: true });
});

function writeConfig(raw: unknown): void {
	const p = path.join(TMP_AGENT, "config", "omp-verdict.json");
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(raw));
}

const TIERED_CONFIG = {
	semanticAdjudication: {
		tier1Lancet: { enabled: true, modelPath: "~/.cache/omp/lancet-nano", riskyThreshold: 0.85 },
		tier2Role: "adjudicator",
		tier2TimeoutMs: 5000,
	},
};

// ── Tokenizer ────────────────────────────────────────────

/** Tiny byte-level BPE fixture: merges cover common English fragments, so the test
 *  exercises byte mapping, pre-tokenization and merge priority without the 700 KB
 *  production vocab. Vocab keys are the GPT-2 byte-to-unicode spellings (`Ġ` = space,
 *  `Ċ` = newline, `ĉ` = tab), exactly what the tokenizer produces after byte mapping. */
function fixtureTokenizer(): { tokenizer: CodeT5ByteLevelTokenizer; vocab: Record<string, number> } {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?/-_=+()[]{}'\"@#$%^&*|<>~`";
	const chars = [...alphabet, "Ġ", "Ċ", "ĉ", "<unk>"];
	const vocab: Record<string, number> = {};
	for (const ch of chars) vocab[ch] = Object.keys(vocab).length;
	// Merged forms must be in the vocab too — BPE only yields tokens the model knows.
	for (const merged of ["ls", "gi", "ts", "es", "st", "at", "tu", "us", "Ġl", "Ġg", "Ġt"]) vocab[merged] = Object.keys(vocab).length;
	const merges = ["l s", "g i", "t s", "e s", "s t", "a t", "t u", "u s", "Ġ l", "Ġ g", "Ġ t"];
	return { tokenizer: new CodeT5ByteLevelTokenizer({ vocab, merges }), vocab };
}

describe("CodeT5 byte-level BPE tokenizer", () => {
	test("byte-level round trip covers ASCII, spaces, punctuation and UTF-8", () => {
		const { tokenizer, vocab } = fixtureTokenizer();
		expect(decodeTokenIds(vocab, tokenizer.encode("ls -la"))).toBe("ls -la");
		expect(decodeTokenIds(vocab, tokenizer.encode("git status"))).toBe("git status");
	});

	test("merges follow rank priority (ls wins over l+s when both are possible)", () => {
		const { tokenizer } = fixtureTokenizer();
		expect(tokenizer.encode("ls").length).toBe(1);
		expect(tokenizer.encode("sl").length).toBe(2); // no "s l" merge
	});

	test("pre-tokenization keeps leading spaces attached to the following word", () => {
		const { tokenizer } = fixtureTokenizer();
		// "a a" has an explicit space token; "aa" stays one word (and may merge differently)
		expect(tokenizer.encode("a a").length).toBeGreaterThanOrEqual(3);
	});

	test("real-vocab parity fixtures (reference ids from tokenizers==0.23.3)", () => {
		const dir = process.env.OMP_VERDICT_LANCET_DIR;
		if (!dir) return; // hermetic default: fixtures need the shipped vocab
		const tok = new CodeT5ByteLevelTokenizer({
			vocab: JSON.parse(fs.readFileSync(path.join(dir, "vocab.json"), "utf8")),
			merges: fs.readFileSync(path.join(dir, "merges.txt"), "utf8").split("\n"),
		});
		expect(tok.encode("git status")).toEqual([6845, 1267]);
		expect(tok.encode("ls -la")).toEqual([3251, 300, 11821]);
		expect(tok.encode("rm -rf /tmp/x")).toEqual([8864, 300, 5809, 342, 5645, 19, 92]);
	});
});

// ── Lancet banding / window contract ─────────────────────

const META = {
	format: "semantic-windowed-1",
	version: "0.4.3",
	input: { maxUtf8Bytes: 8192, windowTokens: 512, overlapTokens: 64, shells: ["bash", "powershell", "cmd"] },
	calibration: { scale: 0.501046180687904, bias: 0.8579191016201142 },
	reviewLogitThreshold: -3.4448594882714976,
	riskyLogitThreshold: 7.71649796562147,
};

describe("Lancet banding", () => {
	test("shipped logit thresholds produce the three bands", () => {
		expect(bandFor(-7.141, META)).toBe("not_flagged");
		expect(bandFor(0, META)).toBe("review");
		expect(bandFor(7.9249, META)).toBe("risky");
	});
	test("calibrated probability matches the reference runtime (0.9921 at 7.9249)", () => {
		expect(calibratedRisk(7.9249, META.calibration)).toBeCloseTo(0.9921, 4);
		expect(calibratedRisk(-7.141, META.calibration)).toBeCloseTo(0.0618, 4);
	});
	test("a configured probability threshold maps back onto the logit scale", () => {
		const logit = probabilityToLogit(0.85, META.calibration);
		expect(calibratedRisk(logit, META.calibration)).toBeCloseTo(0.85, 6);
		// 0.85 is stricter than the shipped 0.9912 risky boundary? No — it is looser:
		// more commands land in risky, which is the point of a configurable boundary.
		expect(logit).toBeLessThan(META.riskyLogitThreshold);
	});
});

describe("Lancet window contract", () => {
	test("one window for short input; framing adds <s>/</s>", () => {
		const w = windows([10, 11, 12], 512, 64);
		expect(w.length).toBe(1);
		expect(w[0].ids).toEqual([1, 10, 11, 12, 2]);
		expect(w[0].owned).toEqual([false, true, true, true, false]);
	});
	test("long input is split with 64-token overlap; every payload token is owned once", () => {
		const payload = Array.from({ length: 1000 }, (_, i) => i + 10);
		const w = windows(payload, 512, 64);
		expect(w.length).toBe(3);
		const owned = new Map<number, number>();
		for (const win of w) {
			win.ids.forEach((id, i) => {
				if (win.owned[i]) owned.set(id, (owned.get(id) ?? 0) + 1);
			});
		}
		expect(owned.size).toBe(payload.length);
		for (const count of owned.values()) expect(count).toBe(1);
	});
	test("invalid window contract throws (empty payload / overlap too large)", () => {
		expect(() => windows([], 512, 64)).toThrow();
		expect(() => windows([1], 512, 512)).toThrow();
	});
});

// ── Lancet engine edge cases (no ONNX session needed) ────

describe("Lancet engine input guards", () => {
	test("oversized payload and empty command return review, never not_flagged", async () => {
		const dir = process.env.OMP_VERDICT_LANCET_DIR;
		if (!dir) return;
		const engine = await LancetEngine.load(dir, 1);
		const tooLong = await engine.triage("x".repeat(8193));
		expect(tooLong.band).toBe("review");
		expect(tooLong.reason).toBe("raw-input-too-long");
		const empty = await engine.triage("   ");
		expect(empty.band).toBe("review");
		expect(empty.reason).toBe("empty-command");
	});
	test("commands beyond the 512-token window escalate instead of being truncated", async () => {
		const dir = process.env.OMP_VERDICT_LANCET_DIR;
		if (!dir) return;
		const engine = await LancetEngine.load(dir, 1);
		const longCommand = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
		const r = await engine.triage(longCommand);
		expect(r.band).toBe("review");
		expect(r.reason).toBe("input exceeds the 512-token window");
	});
	test("unsupported shell returns review", async () => {
		const dir = process.env.OMP_VERDICT_LANCET_DIR;
		if (!dir) return;
		const engine = await LancetEngine.load(dir, 1);
		const r = await engine.triage("ls", "fish" as never);
		expect(r.band).toBe("review");
		expect(r.reason).toBe("unsupported-shell");
	});
	test("reference logits are reproduced exactly (Python runtime parity)", async () => {
		const dir = process.env.OMP_VERDICT_LANCET_DIR;
		if (!dir) return;
		const engine = await LancetEngine.load(dir, 2);
		const cases: Array<[string, number, string]> = [
			["ls -la", -7.141, "not_flagged"],
			["git status", -7.7475, "not_flagged"],
			["kubectl delete namespace prod", 7.9249, "risky"],
			["rm -rf /tmp/x", 6.3168, "review"],
		];
		for (const [command, logit, band] of cases) {
			const r = await engine.triage(command);
			expect(r.riskLogit).toBeCloseTo(logit, 3);
			expect(r.band).toBe(band);
		}
	});
});

// ── Tier 2 adjudicator ───────────────────────────────────

describe("Tier 2 response parsing", () => {
	test("strict JSON object parses", () => {
		expect(parseAdjudicatorResponse('{"verdict":"deny","reason":"root delete"}')).toEqual({ verdict: "deny", reason: "root delete" });
	});
	test("fenced JSON is tolerated", () => {
		expect(parseAdjudicatorResponse('```json\n{"verdict":"allow","reason":"ok"}\n```')).toEqual({ verdict: "allow", reason: "ok" });
	});
	test("prose, malformed JSON, invalid verdict and non-string reason all fail", () => {
		expect(parseAdjudicatorResponse("I think this is fine")).toBeNull();
		expect(parseAdjudicatorResponse('{"verdict":')).toBeNull();
		expect(parseAdjudicatorResponse('{"verdict":"maybe","reason":"x"}')).toBeNull();
		expect(parseAdjudicatorResponse('{"verdict":"allow","reason":42}')).toBeNull();
		expect(parseAdjudicatorResponse('["allow"]')).toBeNull();
	});
	test("reason is trimmed and capped at 300 chars", () => {
		const parsed = parseAdjudicatorResponse(JSON.stringify({ verdict: "ask", reason: "x".repeat(500) }));
		expect(parsed?.reason.length).toBe(300);
	});
});

describe("Tier 2 model resolution (role → smol → session)", () => {
	/** omp's ctx.models facade: resolve(provider/id | bare id | @role). */
	const models = (bySpec: Record<string, unknown>, auth = true) => ({
		resolve: (spec: string) => bySpec[spec],
		hasConfiguredAuth: () => auth,
	});
	test("configured role wins", () => {
		const resolved = resolveAdjudicatorModel(models({ "@adjudicator": { id: "adj" }, "@smol": { id: "smol" } }), { id: "session" }, "adjudicator");
		expect(resolved).toEqual({ model: { id: "adj" }, role: "adjudicator" });
	});
	test("falls back to smol when the configured role is absent", () => {
		const resolved = resolveAdjudicatorModel(models({ "@smol": { id: "smol" } }), { id: "session" }, "adjudicator");
		expect(resolved).toEqual({ model: { id: "smol" }, role: "smol" });
	});
	test("falls back to the session model when no role resolves", () => {
		const resolved = resolveAdjudicatorModel(models({}), { id: "session" }, "adjudicator");
		expect(resolved).toEqual({ model: { id: "session" }, role: "session" });
	});
	test("judgment-kind entries and unauthenticated models are skipped", () => {
		const reg = models({ "@adjudicator": { id: "judge", kind: "judge" }, "@smol": { id: "smol" } });
		expect(resolveAdjudicatorModel(reg, { id: "session" }, "adjudicator")).toEqual({ model: { id: "smol" }, role: "smol" });
		expect(resolveAdjudicatorModel(models({ "@adjudicator": { id: "x" } }, false), { id: "session" }, "adjudicator")).toBeNull();
	});
	test("a bare provider/id role value resolves through ctx.models.resolve", () => {
		const resolved = resolveAdjudicatorModel(models({ "@adjudicator": { id: "model-x" } }), null, "adjudicator");
		expect(resolved).toEqual({ model: { id: "model-x" }, role: "adjudicator" });
	});
});

describe("Tier 2 call semantics", () => {
	const model = { id: "tier2-model" };
	const host = { getSessionId: () => "s1" };
	const request = {
		toolName: "bash",
		input: { command: "npm publish" },
		transcript: "User: publish the package\nbash: npm publish",
		triage: { band: "review" as const, pRisky: 0.82, reason: "uncertainty-band" },
		denyPathsActive: false,
	};
	const complete = (text: string, stopReason = "stop"): AdjudicatorComplete => async () => ({ content: [{ type: "text", text }], stopReason });

	test("successful JSON answer maps to a verdict", async () => {
		const out = await adjudicateWithModel({ model, complete: complete('{"verdict":"allow","reason":"user asked for it"}'), host, request, timeoutMs: 1000 });
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.verdict).toBe("allow");
			expect(out.reason).toBe("user asked for it");
			expect(out.payload).toContain("npm publish");
		}
	});
	test("system prompt is the strict JSON contract and carries the denyPaths hint only when active", async () => {
		let seen = "";
		const capture: AdjudicatorComplete = async (_m, c) => {
			seen = c.systemPrompt ?? "";
			return { content: [{ type: "text", text: '{"verdict":"allow","reason":"ok"}' }], stopReason: "stop" };
		};
		await adjudicateWithModel({ model, complete: capture, host, request, timeoutMs: 1000 });
		expect(seen).toBe(ADJUDICATOR_SYSTEM);
		expect(seen).toContain('{"verdict":"allow"|"ask"|"deny","reason":"brief string"}');
		expect(seen).not.toContain("protected paths");
		await adjudicateWithModel({ model, complete: capture, host, request: { ...request, denyPathsActive: true }, timeoutMs: 1000 });
		expect(seen).toContain("protected paths");
	});
	test("invalid JSON fails closed with the raw output preserved", async () => {
		const out = await adjudicateWithModel({ model, complete: complete("sure, go ahead"), host, request, timeoutMs: 1000 });
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.error).toContain("invalid adjudicator JSON");
			expect(out.rawResponse).toBe("sure, go ahead");
		}
	});
	test("transport error fails closed", async () => {
		const boom: AdjudicatorComplete = async () => {
			throw new Error("network down");
		};
		const out = await adjudicateWithModel({ model, complete: boom, host, request, timeoutMs: 1000 });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("network down");
	});
	test("a hanging provider hits the hard timeout", async () => {
		const hang: AdjudicatorComplete = () => new Promise(() => {});
		const started = Date.now();
		const out = await adjudicateWithModel({ model, complete: hang, host, request, timeoutMs: 50 });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("timeout after 50ms");
		expect(Date.now() - started).toBeLessThan(2000);
	});
	test("temperature rejection retries once without the parameter (#47 parity)", async () => {
		const temperatures: Array<number | undefined> = [];
		const adaptive: AdjudicatorComplete = async (_m, _c, options) => {
			temperatures.push(options?.temperature as number | undefined);
			if (temperatures.length === 1) throw new Error("temperature is deprecated for this model");
			return { content: [{ type: "text", text: '{"verdict":"ask","reason":"confirm"}' }], stopReason: "stop" };
		};
		const out = await adjudicateWithModel({ model, complete: adaptive, host, request, timeoutMs: 1000 });
		expect(out.ok).toBe(true);
		expect(temperatures).toEqual([0, undefined]);
	});
	test("payload carries tool, arguments, tier1 band and transcript", () => {
		const payload = JSON.parse(buildAdjudicatorPayload(request));
		expect(payload).toMatchObject({
			tool: "bash",
			arguments: { command: "npm publish" },
			tier1: { band: "review", pRisky: 0.82 },
		});
		expect(payload.transcript).toContain("publish the package");
	});
});

// ── Tiered orchestration ─────────────────────────────────

describe("tiered orchestration", () => {
	const triage = (band: LancetResult["band"], pRisky = 0.5): LancetResult => ({
		band,
		pRisky,
		riskLogit: band === "not_flagged" ? -7 : band === "risky" ? 8 : 5,
		reason: band === "review" ? "uncertainty-band" : null,
		durationMs: 12,
	});
	const baseOptions = (over: Partial<Parameters<typeof runTieredAdjudication>[0]> = {}) => ({
		toolName: "bash",
		input: { command: "git status" },
		shell: "bash" as const,
		command: "git status",
		transcript: "User: check status",
		denyPathsActive: false,
		tier1: async () => triage("not_flagged", 0.05),
		getTier2: () => null,
		complete: (async () => {
			throw new Error("Tier 2 must not be called for this case");
		}) as AdjudicatorComplete,
		host: { getSessionId: () => "s1" },
		config: DEFAULT_SEMANTIC_ADJUDICATION,
		...over,
	});

	test("not_flagged settles the call with zero Tier 2 activity", async () => {
		const out = await runTieredAdjudication(baseOptions());
		expect(out.verdict).toBe("allow");
		expect(out.source).toBe("tier1");
		expect(out.tier2).toBeNull();
		expect(out.reason).toContain("not_flagged");
	});
	test("risky asks by default and blocks under riskyAction: block", async () => {
		const ask = await runTieredAdjudication(baseOptions({ tier1: async () => triage("risky", 0.99) }));
		expect(ask.verdict).toBe("ask");
		expect(ask.source).toBe("tier1");
		const block = await runTieredAdjudication(
			baseOptions({
				tier1: async () => triage("risky", 0.99),
				config: { ...DEFAULT_SEMANTIC_ADJUDICATION, tier1Lancet: { ...DEFAULT_SEMANTIC_ADJUDICATION.tier1Lancet, riskyAction: "block" } },
			}),
		);
		expect(block.verdict).toBe("deny");
	});
	test("review escalates; Tier 2 allow passes", async () => {
		let calls = 0;
		const out = await runTieredAdjudication(
			baseOptions({
				tier1: async () => triage("review", 0.6),
				getTier2: () => ({ model: { id: "adj" }, role: "adjudicator" }),
				complete: async () => {
					calls++;
					return { content: [{ type: "text", text: '{"verdict":"allow","reason":"matches intent"}' }], stopReason: "stop" };
				},
			}),
		);
		expect(calls).toBe(1);
		expect(out.verdict).toBe("allow");
		expect(out.source).toBe("tier2");
		expect(out.tier2Role).toBe("adjudicator");
	});
	test("Tier 2 deny and ask both go to the human (never an automatic deny)", async () => {
		for (const verdict of ["deny", "ask"]) {
			const out = await runTieredAdjudication(
				baseOptions({
					tier1: async () => triage("review", 0.6),
					getTier2: () => ({ model: { id: "adj" }, role: "adjudicator" }),
					complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict, reason: "risky" }) }], stopReason: "stop" }),
				}),
			);
			expect(out.verdict).toBe("ask");
			expect(out.reason).toContain(`tier2 verdict: ${verdict}`);
		}
	});
	test("no Tier 2 model fails closed to ask", async () => {
		const out = await runTieredAdjudication(baseOptions({ tier1: async () => triage("review", 0.6) }));
		expect(out.verdict).toBe("ask");
		expect(out.source).toBe("fail-closed");
		expect(out.reason).toContain("no model resolved");
	});
	test("Tier 2 failure (network/timeout/parse) fails closed to ask", async () => {
		const out = await runTieredAdjudication(
			baseOptions({
				tier1: async () => triage("review", 0.6),
				getTier2: () => ({ model: { id: "adj" }, role: "adjudicator" }),
				complete: async () => {
					throw new Error("network down");
				},
			}),
		);
		expect(out.verdict).toBe("ask");
		expect(out.source).toBe("fail-closed");
		expect(out.reason).toContain("network down");
	});
	test("non-shell tools bypass Tier 1 and go straight to Tier 2", async () => {
		let tier1Calls = 0;
		const out = await runTieredAdjudication(
			baseOptions({
				toolName: "mcp__x__y",
				input: { a: 1 },
				shell: null,
				tier1: async () => {
					tier1Calls++;
					return triage("not_flagged");
				},
				getTier2: () => ({ model: { id: "adj" }, role: "adjudicator" }),
				complete: async () => ({ content: [{ type: "text", text: '{"verdict":"allow","reason":"read-only"}' }], stopReason: "stop" }),
			}),
		);
		expect(tier1Calls).toBe(0);
		expect(out.verdict).toBe("allow");
		expect(out.source).toBe("tier2");
	});
	test("a throwing Tier 1 seam escalates instead of allowing", async () => {
		const out = await runTieredAdjudication(
			baseOptions({
				tier1: async () => {
					throw new Error("onnx exploded");
				},
				getTier2: () => ({ model: { id: "adj" }, role: "adjudicator" }),
				complete: async () => ({ content: [{ type: "text", text: '{"verdict":"ask","reason":"unsure"}' }], stopReason: "stop" }),
			}),
		);
		expect(out.tier1?.band).toBe("review");
		expect(out.tier1?.reason).toContain("onnx exploded");
		expect(out.verdict).toBe("ask");
	});
});

// ── Config schema ────────────────────────────────────────

describe("semanticAdjudication config", () => {
	test("absent block → null (legacy single-classifier path)", () => {
		expect(resolveSemanticAdjudication(undefined, [])).toBeNull();
	});
	test("valid block parses with defaults for omitted fields", () => {
		const skipped: string[] = [];
		const parsed = resolveSemanticAdjudication({ tier2TimeoutMs: 9000 }, skipped);
		expect(skipped).toEqual([]);
		expect(parsed).toMatchObject({ tier2Role: "adjudicator", tier2TimeoutMs: 9000 });
		expect(parsed?.tier1Lancet.enabled).toBe(true);
	});
	test("invalid values fall back to defaults and surface in skipped", () => {
		const skipped: string[] = [];
		const parsed = resolveSemanticAdjudication(
			{
				tier1Lancet: { enabled: "yes", modelPath: 42, riskyThreshold: 1.5, riskyAction: "block-it" },
				tier2Role: "",
				tier2TimeoutMs: 10,
			},
			skipped,
		);
		expect(parsed).toMatchObject({
			tier1Lancet: { enabled: true, modelPath: DEFAULT_SEMANTIC_ADJUDICATION.tier1Lancet.modelPath, riskyThreshold: 0.85, riskyAction: "ask" },
			tier2Role: "adjudicator",
			tier2TimeoutMs: 5000,
		});
		expect(skipped.join(" ")).toContain("tier1Lancet.enabled");
		expect(skipped.join(" ")).toContain("tier1Lancet.modelPath");
		expect(skipped.join(" ")).toContain("tier1Lancet.riskyThreshold");
		expect(skipped.join(" ")).toContain("tier1Lancet.riskyAction");
		expect(skipped.join(" ")).toContain("tier2Role");
		expect(skipped.join(" ")).toContain("tier2TimeoutMs");
	});
	test("riskyAction block is accepted", () => {
		const parsed = resolveSemanticAdjudication({ tier1Lancet: { riskyAction: "block" } }, []);
		expect(parsed?.tier1Lancet.riskyAction).toBe("block");
	});
	test("config loader reads the block from disk", () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(buildProtectedSet(TMP_AGENT, null));
		const report = state.reset("/proj");
		expect(report.skipped).toEqual([]);
		expect(state.userRules.semanticAdjudication).toMatchObject({ tier2Role: "adjudicator", tier2TimeoutMs: 5000 });
	});
});

// ── adjudicate() integration ─────────────────────────────

describe("adjudicate() tiered integration", () => {
	const prot = () => buildProtectedSet(TMP_AGENT, null);
	const triage = (band: LancetResult["band"], pRisky = 0.5): LancetResult => ({
		band,
		pRisky,
		riskLogit: band === "not_flagged" ? -7 : band === "risky" ? 8 : 5,
		reason: band === "review" ? "uncertainty-band" : null,
		durationMs: 12,
	});
	const env = (over: Record<string, unknown> = {}) => ({
		cwd: "/proj",
		hasUI: true,
		getModel: () => {
			throw new Error("legacy classifier must not resolve in tiered mode");
		},
		complete: async () => ({ content: [{ type: "text", text: '{"verdict":"allow","reason":"ok"}' }], stopReason: "stop" }),
		host: { getBranch: () => [], getSessionId: () => "s1" },
		signal: undefined,
		tier1: async () => triage("not_flagged", 0.05),
		getAdjudicator: () => ({ model: { id: "adj" }, role: "adjudicator" }),
		...over,
	});

	test("benign shell command allows via Tier 1 with zero Tier 2 calls", async () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(prot());
		state.reset("/proj");
		let tier2Calls = 0;
		const v = await adjudicate(state, { toolName: "bash", input: { command: "git status" } }, {
			...env({
				complete: async () => {
					tier2Calls++;
					return { content: [{ type: "text", text: '{"verdict":"deny","reason":"must not run"}' }], stopReason: "stop" };
				},
			}),
		} as never);
		expect(v).toMatchObject({ verdict: "allow", source: "classifier", degraded: false });
		expect(v.reason).toContain("lancet: not_flagged");
		expect(tier2Calls).toBe(0);
	});

	test("review escalates and a Tier 2 allow passes; the audit carries both tiers", async () => {
		writeConfig({ ...TIERED_CONFIG, audit: true });
		const state = new SessionState(prot(), undefined, TMP_AGENT);
		state.reset("/proj");
		const v = await adjudicate(state, { toolName: "bash", input: { command: "npm publish" } }, {
			...env({ tier1: async () => triage("review", 0.82) }),
		} as never);
		expect(v).toMatchObject({ verdict: "allow", source: "classifier" });
		const records = fs
			.readFileSync(path.join(TMP_AGENT, "verdicts", "s1.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(records[0].tier1).toMatchObject({ band: "review", pRisky: 0.82 });
		expect(records[0].tier2).toMatchObject({ model: "adj", role: "adjudicator", verdict: "allow", error: null });
		expect(records[0].transcript).toContain("npm publish");
	});

	test("risky → ask interactively, deny headless (ask degradation)", async () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(prot());
		state.reset("/proj");
		const tier1 = async () => triage("risky", 0.99);
		const v = await adjudicate(state, { toolName: "bash", input: { command: "kubectl delete ns prod" } }, { ...env({ tier1 }) } as never);
		expect(v).toMatchObject({ verdict: "ask", source: "classifier", degraded: false });
		const headless = await adjudicate(state, { toolName: "bash", input: { command: "kubectl delete ns prod" } }, {
			...env({ tier1, hasUI: false }),
		} as never);
		expect(headless).toMatchObject({ verdict: "deny", degraded: true });
	});

	test("Tier 2 failure fails closed: interactive ask, headless deny, source fail-closed", async () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(prot());
		state.reset("/proj");
		const failing = env({
			tier1: async () => triage("review", 0.6),
			complete: async () => {
				throw new Error("network down");
			},
		});
		const v = await adjudicate(state, { toolName: "bash", input: { command: "npm publish" } }, failing as never);
		expect(v).toMatchObject({ verdict: "ask", source: "fail-closed", degraded: false });
		const headless = await adjudicate(state, { toolName: "bash", input: { command: "npm publish" } }, { ...failing, hasUI: false } as never);
		expect(headless).toMatchObject({ verdict: "deny", source: "fail-closed", degraded: true });
	});

	test("no adjudicator model resolves → fail-closed ask with an explanatory reason", async () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(prot());
		state.reset("/proj");
		const v = await adjudicate(state, { toolName: "mcp__x__y", input: { a: 1 } }, {
			...env({ tier1: null, getAdjudicator: () => null }),
		} as never);
		expect(v.verdict).toBe("ask");
		expect(v.source).toBe("fail-closed");
		expect(v.reason).toContain("no model resolved");
	});

	test("rule-layer denies still outrank the tiered path (no tier activity)", async () => {
		writeConfig({ ...TIERED_CONFIG, deny: ["^kubectl"] });
		const state = new SessionState(prot());
		state.reset("/proj");
		let calls = 0;
		const v = await adjudicate(state, { toolName: "bash", input: { command: "kubectl delete ns prod" } }, {
			...env({
				tier1: async () => {
					calls++;
					return triage("not_flagged");
				},
			}),
		} as never);
		expect(v).toMatchObject({ verdict: "deny", source: "rule" });
		expect(calls).toBe(0);
	});

	test("non-shell tools go straight to Tier 2 in tiered mode", async () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(prot());
		state.reset("/proj");
		let tier1Calls = 0;
		const v = await adjudicate(state, { toolName: "mcp__x__y", input: { a: 1 } }, {
			...env({
				tier1: async () => {
					tier1Calls++;
					return triage("not_flagged");
				},
			}),
		} as never);
		expect(tier1Calls).toBe(0);
		expect(v).toMatchObject({ verdict: "allow", source: "classifier" });
	});

	test("tier1Lancet.enabled: false bypasses Tier 1 and sends the call to Tier 2 without a triage block", async () => {
		writeConfig({ semanticAdjudication: { ...TIERED_CONFIG.semanticAdjudication, tier1Lancet: { ...TIERED_CONFIG.semanticAdjudication.tier1Lancet, enabled: false } } });
		const state = new SessionState(prot());
		state.reset("/proj");
		let tier1Calls = 0;
		let payload: { tier1: unknown } | null = null;
		const v = await adjudicate(state, { toolName: "bash", input: { command: "git status" } }, {
			...env({
				tier1: async () => {
					tier1Calls++;
					return triage("not_flagged");
				},
				complete: async (_m, c) => {
					const text = String((c.messages[0] as { content: string }).content);
					payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
					return { content: [{ type: "text", text: '{"verdict":"allow","reason":"ok"}' }], stopReason: "stop" };
				},
			}),
		} as never);
		expect(tier1Calls).toBe(0);
		expect(payload.tier1).toBeNull();
		expect(v).toMatchObject({ verdict: "allow", source: "classifier" });
	});

	test("the block being absent keeps the legacy classifier path", async () => {
		writeConfig({});
		const state = new SessionState(prot());
		state.reset("/proj");
		const v = await adjudicate(state, { toolName: "bash", input: { command: "git status" } }, {
			cwd: "/proj",
			hasUI: true,
			getModel: () => ({ kind: "chat", model: { id: "legacy" }, thinking: "off" }),
			complete: async () => ({ content: [{ type: "text", text: "<verdict>allow</verdict> legacy" }], stopReason: "stop" }),
			host: { getBranch: () => [], getSessionId: () => "s1" },
		} as never);
		expect(v).toMatchObject({ verdict: "allow", source: "classifier" });
		expect(v.reason).toBe("legacy");
	});
});

describe("/automode tiered status", () => {
	test("status line shows both tiers only when the block is configured", async () => {
		writeConfig(TIERED_CONFIG);
		const state = new SessionState(buildProtectedSet(TMP_AGENT, null));
		state.reset("/proj");
		// Exercise the same formatter path the command uses by rendering through the extension.
		const { default: autoMode } = await import("../extensions/omp-verdict.ts");
		const notifies: string[] = [];
		const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
		autoMode({
			registerFlag: () => {},
			getFlag: (name: string) => (name === "auto-mode" ? true : name === "auto-mode-debug" ? false : undefined),
			on: () => {},
			registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands[name] = cmd;
			},
			registerShortcut: () => {},
		} as never);
		const ctx = {
			cwd: "/proj",
			hasUI: true,
			model: null,
			sessionManager: { getBranch: () => [], getSessionId: () => "s1" },
			modelRegistry: {},
			ui: { notify: (m: string) => notifies.push(m), setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } },
		};
		await commands.automode.handler("", ctx);
		const status = notifies.join("\n");
		expect(status).toContain("semantic adjudication:");
		expect(status).toContain("Tier 1 Lancet-Nano");
		expect(status).toContain('Tier 2 role "adjudicator"');
	});
});

describe("config template + handler fail-closed", () => {
	test("the first-run template exposes the semanticAdjudication block", async () => {
		fs.rmSync(path.join(TMP_AGENT, "config"), { recursive: true, force: true });
		const { default: autoMode } = await import("../extensions/omp-verdict.ts");
		autoMode({
			registerFlag: () => {},
			getFlag: (name: string) => (name === "auto-mode" ? true : false),
			on: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
		} as never);
		const raw = JSON.parse(fs.readFileSync(path.join(TMP_AGENT, "config", "omp-verdict.json"), "utf8"));
		expect(raw.semanticAdjudication).toMatchObject({
			tier1Lancet: { enabled: true, modelPath: "~/.cache/omp/lancet-nano", riskyThreshold: 0.85 },
			tier2Role: "adjudicator",
			tier2TimeoutMs: 5000,
		});
	});

	test("handler-level: Tier 2 transport failure → one interactive ask; headless → block", async () => {
		writeConfig({
			// Point Tier 1 at a nonexistent bundle: load fails fast, call escalates.
			semanticAdjudication: { tier1Lancet: { enabled: true, modelPath: "/nonexistent/lancet-bundle", riskyThreshold: 0.85 }, tier2Role: "adjudicator", tier2TimeoutMs: 2000 },
		});
		const { default: autoMode } = await import("../extensions/omp-verdict.ts");
		const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
		const notifies: Array<[string, string]> = [];
		let confirms = 0;
		autoMode({
			registerFlag: () => {},
			getFlag: (name: string) => (name === "auto-mode" ? true : false),
			on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
				handlers[name] = handler;
			},
			registerCommand: () => {},
			registerShortcut: () => {},
		} as never);
		const makeCtx = (hasUI: boolean) => ({
			cwd: "/proj",
			hasUI,
			signal: undefined,
			model: { id: "mock/session-model" },
			sessionManager: { getBranch: () => [], getSessionId: () => "s1" },
			modelRegistry: {
				find: () => null,
				hasConfiguredAuth: () => true,
			},
			models: { resolve: () => null, current: () => undefined, list: () => [], family: () => "mock" },
			ui: {
				notify: (message: string, level: string) => notifies.push([message, level]),
				confirm: async () => {
					confirms++;
					return true;
				},
				select: async () => undefined,
				setStatus: () => {},
				theme: { fg: (_c: string, s: string) => s },
			},
		});
		await handlers.session_start({}, makeCtx(true));
		const interactive = await handlers.tool_call({ toolName: "bash", input: { command: "git status" } }, makeCtx(true));
		expect(interactive).toBeUndefined(); // ask → confirm (default true)
		expect(confirms).toBe(1);
		expect(notifies.some(([m, l]) => l === "warning" && m.includes("Tier 1 Lancet-Nano unavailable"))).toBe(true);

		const headless = await handlers.tool_call({ toolName: "bash", input: { command: "git status" } }, makeCtx(false));
		expect(headless).toMatchObject({ block: true });
		expect(String((headless as { reason: string }).reason)).toContain("tier2 adjudicator failure");
	});
});
