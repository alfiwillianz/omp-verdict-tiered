/**
 * ADR-0009: the tiered semantic adjudication pipeline.
 *
 *   Tier 1 (local, ~10ms): LANCET-Nano triage of a shell command.
 *     not_flagged → allow immediately
 *     risky       → ask (default) or deny (riskyAction: "block")
 *     review      → escalate
 *   Tier 2 (model registry): a generative adjudicator with session context.
 *     allow       → allow
 *     ask / deny  → ask (a model may not auto-deny here; a human confirms)
 *     failure     → ask (fail-closed; headless sessions degrade to deny)
 *
 * Tier 1 only ever sees the command string. Tier 2 sees the tool call, the
 * condensed transcript, and Tier 1's band/reason. The pipeline is deliberately
 * a separate module from the extension so the decision logic is testable without
 * a host runtime.
 */

import type { LancetResult } from "./lancet";
import { adjudicateWithModel } from "./omp-adjudicator";
import type { AdjudicatorComplete, AdjudicatorModel, AdjudicatorOutcome, AdjudicatorRequest } from "./omp-adjudicator";

export type ShellKind = "bash" | "powershell" | "cmd";

/** ADR-0009 configuration block. Defaults: Tier 1 enabled (inert until a verified
 *  bundle loads), the task's stricter 0.85 risky boundary, risky → ask, the
 *  `adjudicator` role, 5s Tier 2 budget. */
export interface SemanticAdjudicationConfig {
	tier1Lancet: {
		enabled: boolean;
		/** Bundle directory; `~` is expanded. Default `~/.cache/pi/lancet-nano`. */
		modelPath: string;
		/** Calibrated risk probability at/above which Tier 1 says `risky` (0–1). */
		riskyThreshold: number;
		/** What a `risky` band does without consulting Tier 2: `"ask"` (default —
		 *  a human confirms) or `"block"` (deterministic deny). */
		riskyAction: "ask" | "block";
	};
	/** Role resolved via the host registry (`adjudicator` → `smol` → session model). */
	tier2Role: string;
	/** Hard ceiling for one Tier 2 call; on expiry the pipeline fails closed. */
	tier2TimeoutMs: number;
}

/** Tier 1 seam: local triage. The extension binds a loaded LancetEngine; tests
 *  bind a fake. It must never throw — a failure is an escalation signal. */
export type Tier1Fn = (command: string, shell: ShellKind) => Promise<LancetResult>;

export interface TieredOptions {
	toolName: string;
	input: Record<string, unknown>;
	/** Non-null for shell tools with Tier 1 enabled; null means "bypass Tier 1,
	 *  go straight to Tier 2". */
	shell: ShellKind | null;
	command: string;
	transcript: string;
	denyPathsActive: boolean;
	tier1: Tier1Fn | null;
	/** Lazy: resolved only when a call actually escalates (a Tier 1 allow must not
	 *  pay model resolution or its warning). */
	getTier2: () => { model: AdjudicatorModel; role: string } | null;
	complete: AdjudicatorComplete;
	host: { getSessionId: () => string };
	signal?: AbortSignal;
	config: SemanticAdjudicationConfig;
}

export interface TieredOutcome {
	/** Pre-headless-degradation verdict; the caller applies ask→deny when no UI. */
	verdict: "allow" | "ask" | "deny";
	reason: string;
	source: "tier1" | "tier2" | "fail-closed";
	tier1: LancetResult | null;
	tier2: AdjudicatorOutcome | null;
	/** The Tier 2 role that resolved (null when no model resolved). */
	tier2Role: string | null;
	/** Audit material: transcript sent to Tier 2 (null when Tier 1 settled the call). */
	transcript: string | null;
	rawResponse: string | null;
	modelId: string | null;
}

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

/** Human-facing Tier 1 reason line; includes the calibrated probability and, for
 *  risky, the configured boundary that fired. */
function tier1Reason(triage: LancetResult, riskyThreshold: number): string {
	if (triage.band === "risky") return `lancet: risky (pRisky ${pct(triage.pRisky)} ≥ ${pct(riskyThreshold)})`;
	if (triage.band === "not_flagged") return `lancet: not_flagged (pRisky ${pct(triage.pRisky)}, ${Math.round(triage.durationMs)}ms)`;
	return `lancet: review (pRisky ${pct(triage.pRisky)}${triage.reason ? `; ${triage.reason}` : ""}) — escalated to the model adjudicator`;
}

/** Serialize the Tier 1 result for the audit record's rawResponse. */
function triageAudit(triage: LancetResult): string {
	return JSON.stringify({ band: triage.band, pRisky: Number(triage.pRisky.toFixed(4)), riskLogit: triage.riskLogit, reason: triage.reason, durationMs: Math.round(triage.durationMs) });
}

/** Run the tiered decision. Never throws: every failure becomes an ask (the caller
 *  degrades it to deny in headless sessions). */
export async function runTieredAdjudication(options: TieredOptions): Promise<TieredOutcome> {
	const { config } = options;
	let triage: LancetResult | null = null;
	if (options.shell && options.tier1) {
		const tier1 = options.tier1;
		try {
			triage = await tier1(options.command, options.shell);
		} catch (error) {
			// The seam contract says never throw; a broken implementation is still an
			// escalation signal, not an allow.
			triage = {
				band: "review",
				pRisky: 0.5,
				riskLogit: null,
				reason: `lancet failure: ${error instanceof Error ? error.message : String(error)}`,
				durationMs: 0,
			};
		}
		const reason = tier1Reason(triage, config.tier1Lancet.riskyThreshold);
		if (triage.band === "not_flagged") {
			return { verdict: "allow", reason, source: "tier1", tier1: triage, tier2: null, tier2Role: null, transcript: null, rawResponse: triageAudit(triage), modelId: "lancet-nano" };
		}
		if (triage.band === "risky") {
			const verdict = config.tier1Lancet.riskyAction === "block" ? "deny" : "ask";
			return { verdict, reason, source: "tier1", tier1: triage, tier2: null, tier2Role: null, transcript: null, rawResponse: triageAudit(triage), modelId: "lancet-nano" };
		}
		// review → Tier 2
	}

	const tier2 = options.getTier2();
	if (!tier2) {
		return {
			verdict: "ask",
			reason: `tier2 adjudicator unavailable (fail-closed): no model resolved for role "${config.tier2Role}"`,
			source: "fail-closed",
			tier1: triage,
			tier2: null,
			tier2Role: null,
			transcript: null,
			rawResponse: null,
			modelId: null,
		};
	}

	const request: AdjudicatorRequest = {
		toolName: options.toolName,
		input: options.input,
		transcript: options.transcript,
		triage: triage ? { band: triage.band, pRisky: triage.pRisky, reason: triage.reason } : null,
		denyPathsActive: options.denyPathsActive,
	};
	const outcome = await adjudicateWithModel({
		model: tier2.model,
		complete: options.complete,
		host: options.host,
		request,
		timeoutMs: config.tier2TimeoutMs,
		signal: options.signal,
	});
	if (!outcome.ok) {
		return {
			verdict: "ask",
			reason: `tier2 adjudicator failure (fail-closed): ${outcome.error}`,
			source: "fail-closed",
			tier1: triage,
			tier2: outcome,
			tier2Role: tier2.role,
			transcript: options.transcript,
			rawResponse: outcome.rawResponse,
			modelId: outcome.modelId,
		};
	}
	// A Tier 2 `deny` is an opinion, not an automatic block: the task's contract
	// reserves automatic denial for Tier 1's risky band. Anything short of allow
	// goes to a human (headless sessions degrade to deny downstream).
	const verdict = outcome.verdict === "allow" ? "allow" : "ask";
	const reason = outcome.verdict === "allow" ? outcome.reason : `${outcome.reason} (tier2 verdict: ${outcome.verdict} — human confirmation required)`;
	return {
		verdict,
		reason,
		source: "tier2",
		tier1: triage,
		tier2: outcome,
		tier2Role: tier2.role,
		transcript: options.transcript,
		rawResponse: outcome.rawResponse,
		modelId: outcome.modelId,
	};
}
