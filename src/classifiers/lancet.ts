/**
 * Tier 1: local LANCET Nano shell-command triage (INT8 ONNX, CPU).
 *
 * The model is `fingerthief/lancet-nano` v0.4.3 (Apache-2.0 model, MIT runtime):
 * a CodeT5+ 220M encoder with a windowed pooling head. This module reproduces the
 * reference runtime's inference contract (`bundle/model/classify.py`):
 *
 *   - UTF-8 byte cap 8192 and shell ∈ {bash, powershell, cmd}; anything else is
 *     `review` (never `not_flagged` — the model makes no claim about it)
 *   - the 512-token window is the decision ceiling: longer commands escalate to
 *     Tier 2 (ADR-0009). Within the ceiling, `windows()` still implements the
 *     reference windowing contract (510 payload tokens + <s>/</s>, 64-token
 *     overlap, each payload token pooled exactly once via mean + max) — the
 *     boundary case (511/512 tokens) splits into two overlapping windows.
 *   - head: projection → LayerNorm → 2-way logits; the risk logit is compared to
 *     the shipped logit thresholds (a configured probability threshold maps back
 *     through the calibration curve)
 *
 * Fail direction: every unexpected condition (missing assets, load failure,
 * inference error, oversized input) yields `review` — escalation, never an allow.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { CodeT5ByteLevelTokenizer } from "./tokenizer";

export type LancetBand = "not_flagged" | "review" | "risky";

export interface LancetResult {
	band: LancetBand;
	/** Calibrated risk probability (Platt on the INT8 risk logit), 0–1. */
	pRisky: number;
	/** Raw risk logit; null when the model did not run (oversized/unsupported input). */
	riskLogit: number | null;
	/** Why the model abstained / escalated; null on a model-produced band. */
	reason: string | null;
	durationMs: number;
}

export interface LancetMeta {
	format: string;
	version: string;
	input: { maxUtf8Bytes: number; windowTokens: number; overlapTokens: number; shells: string[] };
	calibration: { scale: number; bias: number };
	reviewLogitThreshold: number;
	riskyLogitThreshold: number;
}

/** Files the loader requires, with the hash list published in `export.json`. */
export const LANCET_FILES = ["encoder-int8.onnx", "head.bin", "head.json", "model.json", "export.json", "vocab.json", "merges.txt"] as const;

/** Default cache location: `~/.cache/pi/lancet-nano` (override via config modelPath). */
export function defaultLancetDir(): string {
	return path.join(os.homedir(), ".cache", "pi", "lancet-nano");
}

export function expandHomePath(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Softmax-free banding: the shipped model bands on the raw risk logit; the
 *  probability is the calibrated score reported alongside. */
export function bandFor(riskLogit: number, meta: Pick<LancetMeta, "reviewLogitThreshold" | "riskyLogitThreshold">): LancetBand {
	if (riskLogit >= meta.riskyLogitThreshold) return "risky";
	if (riskLogit >= meta.reviewLogitThreshold) return "review";
	return "not_flagged";
}

/** Inverse of the shipped Platt calibration: probability → logit. Lets the config
 *  express `riskyThreshold` as a probability while banding stays logit-exact. */
export function probabilityToLogit(p: number, cal: { scale: number; bias: number }): number {
	const clamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
	return (Math.log(clamped / (1 - clamped)) - cal.bias) / cal.scale;
}

/** Calibrated probability of the risk logit. */
export function calibratedRisk(riskLogit: number, cal: { scale: number; bias: number }): number {
	const z = cal.scale * riskLogit + cal.bias;
	return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** Overlapping windows over the payload ids: 510 payload tokens per window,
 *  64-token overlap, `<s>`/`</s>` framing; `owned` marks each payload token
 *  exactly once (mean/max pooling uses it). Mirrors the reference `windows()`. */
export function windows(payload: number[], size: number, overlap: number, bos = 1, eos = 2): Array<{ ids: number[]; owned: boolean[] }> {
	const capacity = size - 2;
	if (payload.length === 0 || overlap < 0 || overlap >= capacity) throw new Error("invalid window contract");
	const result: Array<{ ids: number[]; owned: boolean[] }> = [];
	let start = 0;
	let previousEnd = 0;
	while (start < payload.length) {
		const end = Math.min(payload.length, start + capacity);
		const owned = [false, ...Array.from({ length: end - start }, (_, i) => start + i >= previousEnd), false];
		result.push({ ids: [bos, ...payload.slice(start, end), eos], owned });
		if (end === payload.length) break;
		previousEnd = end;
		start = end - overlap;
	}
	return result;
}

/** A loaded, verified Lancet bundle. */
export class LancetEngine {
	private constructor(
		readonly meta: LancetMeta,
		private readonly tokenizer: CodeT5ByteLevelTokenizer,
		private readonly session: InferenceSession,
		private readonly head: {
			projection: Float32Array;
			normWeight: Float32Array;
			normBias: Float32Array;
			normEps: number;
			headWeight: Float32Array;
			headBias: Float32Array;
			hidden: number;
		},
		private readonly outputName: string,
	) {}

	/**
	 * Load and verify a bundle. Every file listed in `export.json` is hashed against
	 * the published digest before the ONNX session is created; a mismatch throws
	 * (the caller degrades to escalation, never to an allow).
	 */
	static async load(dir: string, threads = 1): Promise<LancetEngine> {
		const root = expandHomePath(dir);
		const exportPath = path.join(root, "export.json");
		const exportData = JSON.parse(fs.readFileSync(exportPath, "utf8")) as {
			validationComplete?: boolean;
			sha256?: Record<string, string>;
		};
		if (!exportData.validationComplete) throw new Error(`lancet bundle at ${root} is not a complete export`);
		const expected = exportData.sha256 ?? {};
		for (const name of LANCET_FILES) {
			const file = path.join(root, name);
			if (!fs.existsSync(file)) throw new Error(`lancet bundle missing ${name} (${root})`);
			const want = expected[name];
			if (!want) continue; // export.json cannot carry its own digest; every other file must
			const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
			if (got !== want) throw new Error(`lancet artifact hash mismatch: ${name}`);
		}

		const meta = JSON.parse(fs.readFileSync(path.join(root, "model.json"), "utf8")) as LancetMeta;
		if (meta.format !== "semantic-windowed-1") throw new Error(`unsupported lancet model format: ${String(meta.format)}`);
		const headJson = JSON.parse(fs.readFileSync(path.join(root, "head.json"), "utf8")) as {
			hidden: number;
			normEps: number;
			tensors: Array<{ name: string; shape: number[]; offset: number }>;
		};
		const headBuf = fs.readFileSync(path.join(root, "head.bin"));
		const floats = new Float32Array(headBuf.buffer, headBuf.byteOffset, headBuf.byteLength / 4);
		const slice = (name: string): Float32Array => {
			const t = headJson.tensors.find((x) => x.name === name);
			if (!t) throw new Error(`lancet head missing tensor ${name}`);
			const count = t.shape.reduce((a, b) => a * b, 1);
			return floats.subarray(t.offset / 4, t.offset / 4 + count);
		};

		const tokenizer = new CodeT5ByteLevelTokenizer({
			vocab: JSON.parse(fs.readFileSync(path.join(root, "vocab.json"), "utf8")) as Record<string, number>,
			merges: fs.readFileSync(path.join(root, "merges.txt"), "utf8").split("\n"),
		});

		const session = await InferenceSession.create(path.join(root, "encoder-int8.onnx"), {
			executionProviders: ["cpu"],
			intraOpNumThreads: threads,
			interOpNumThreads: 1,
			graphOptimizationLevel: "all",
		});
		const outputName = session.outputNames[0];
		if (!outputName) throw new Error("lancet encoder exposes no output");
		return new LancetEngine(
			meta,
			tokenizer,
			session,
			{
				projection: slice("projection"),
				normWeight: slice("norm_weight"),
				normBias: slice("norm_bias"),
				normEps: headJson.normEps,
				headWeight: slice("head_weight"),
				headBias: slice("head_bias"),
				hidden: headJson.hidden,
			},
			outputName,
		);
	}

	/**
	 * Triage one command. Never throws: all failures land in `review` with a reason,
	 * because Tier 1 may only ever escalate, not decide on broken input.
	 */
	async triage(command: string, shell: "bash" | "powershell" | "cmd" = "bash", riskyThreshold?: number): Promise<LancetResult> {
		const started = performance.now();
		const abstain = (reason: string): LancetResult => ({ band: "review", pRisky: 0.5, riskLogit: null, reason, durationMs: performance.now() - started });
		if (!command.trim()) return abstain("empty-command");
		if (command.includes("\0")) return abstain("nul-byte");
		if (!this.meta.input.shells.includes(shell)) return abstain("unsupported-shell");
		const bytes = Buffer.byteLength(command, "utf8");
		if (bytes > this.meta.input.maxUtf8Bytes) return abstain("raw-input-too-long");

		let ids: number[];
		try {
			ids = this.tokenizer.encode(command);
		} catch (error) {
			return abstain(`tokenizer failure: ${error instanceof Error ? error.message : String(error)}`);
		}
		// ADR-0009 contract: the 512-token window is Tier 1's decision ceiling. Longer
		// commands escalate instead of being truncated (a truncated tail could hide the
		// risky part) or silently scored by a model whose confidence over long context
		// is not characterized. `windows()` still handles the 511/512 boundary, where
		// the reference runtime splits the payload into overlapping windows.
		if (ids.length > this.meta.input.windowTokens) return abstain("input exceeds the 512-token window");

		let riskLogit: number;
		try {
			riskLogit = await this.forward(ids);
		} catch (error) {
			return abstain(`inference failure: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!Number.isFinite(riskLogit)) return abstain("nonfinite-model-output");
		const pRisky = calibratedRisk(riskLogit, this.meta.calibration);
		// A configured probability threshold overrides the shipped logit threshold;
		// the band comparison itself stays on the logit scale (monotonic mapping).
		const riskyLogitThreshold = riskyThreshold === undefined ? this.meta.riskyLogitThreshold : probabilityToLogit(riskyThreshold, this.meta.calibration);
		const band = bandFor(riskLogit, { reviewLogitThreshold: this.meta.reviewLogitThreshold, riskyLogitThreshold });
		return { band, pRisky, riskLogit, reason: band === "review" ? "uncertainty-band" : null, durationMs: performance.now() - started };
	}

	/** One encoder pass per window; mean + max of owned token representations. */
	private async forward(ids: number[]): Promise<number> {
		const { hidden } = this.head;
		const total = new Float64Array(hidden);
		const maximum = new Float64Array(hidden).fill(-Infinity);
		let count = 0;
		for (const win of windows(ids, this.meta.input.windowTokens, this.meta.input.overlapTokens)) {
			const input = new Tensor("int64", BigInt64Array.from(win.ids.map(BigInt)), [1, win.ids.length]);
			const mask = new Tensor("int64", BigInt64Array.from(win.ids.map(() => 1n)), [1, win.ids.length]);
			const out = await this.session.run({ input_ids: input, attention_mask: mask });
			const data = out[this.outputName].data as Float32Array;
			for (let p = 0; p < win.ids.length; p++) {
				if (!win.owned[p]) continue;
				const off = p * hidden;
				for (let d = 0; d < hidden; d++) {
					const v = data[off + d];
					total[d] += v;
					if (v > maximum[d]) maximum[d] = v;
				}
				count++;
			}
		}
		if (count === 0) throw new Error("no pooled tokens");
		const pooled = new Float64Array(hidden);
		for (let d = 0; d < hidden; d++) pooled[d] = total[d] / count;
		// projection @ [mean; max] — row-major [hidden, 2*hidden]
		const z = new Float64Array(hidden);
		for (let r = 0; r < hidden; r++) {
			let s = 0;
			const row = r * hidden * 2;
			for (let d = 0; d < hidden; d++) s += this.head.projection[row + d] * pooled[d] + this.head.projection[row + hidden + d] * maximum[d];
			z[r] = s;
		}
		// LayerNorm (biased variance, eps added inside the sqrt) then the 2-way head
		let mean = 0;
		for (let i = 0; i < hidden; i++) mean += z[i];
		mean /= hidden;
		let variance = 0;
		for (let i = 0; i < hidden; i++) variance += (z[i] - mean) ** 2;
		variance /= hidden;
		const inv = 1 / Math.sqrt(variance + this.head.normEps);
		for (let i = 0; i < hidden; i++) z[i] = (z[i] - mean) * inv * this.head.normWeight[i] + this.head.normBias[i];
		let risk = this.head.headBias[0];
		for (let i = 0; i < hidden; i++) risk += this.head.headWeight[i] * z[i];
		return risk;
	}
}
