/**
 * CodeT5 byte-level BPE tokenizer (the tokenizer LANCET Nano was trained with).
 *
 * LANCET's bundle ships `vocab.json` + `merges.txt` (a HuggingFace `ByteLevelBPETokenizer`),
 * not a `tokenizer.json`, so the generic `@xenova/transformers` loader cannot read it —
 * it only loads `tokenizer.json`/`tokenizer_config.json`. This module implements the
 * exact pipeline the reference runtime (`tokenizers.ByteLevelBPETokenizer`) applies:
 *
 *   bytes → GPT-2 byte-to-unicode map → GPT-2 pre-tokenization regex → BPE merges
 *
 * Parity with the Python reference is pinned by tests (the fixture ids were produced
 * with `tokenizers==0.23.3` against the shipped vocab/merges).
 */

/** GPT-2 byte→unicode table: printable bytes map to themselves, the rest shift into
 *  the U+0100+ range so every byte is representable as a vocab character. */
const BYTE_TO_UNICODE: string[] = (() => {
	const bs = Array.from({ length: 256 }, (_, i) => i);
	const cs = [...bs];
	let n = 0;
	for (const b of bs) {
		if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255)) continue;
		cs[b] = 256 + n;
		n++;
	}
	return cs.map((c) => String.fromCodePoint(c));
})();

const UNICODE_TO_BYTE: Record<string, number> = Object.fromEntries(
	BYTE_TO_UNICODE.map((ch, byte) => [ch, byte]),
);

/** GPT-2 pre-tokenization regex, identical to the one the reference ByteLevel
 *  pre-tokenizer uses (contractions, letter runs, number runs, punctuation runs,
 *  whitespace runs). */
const PRE_TOKENIZE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export interface BpeTokenizerData {
	vocab: Record<string, number>;
	/** `merges.txt` lines after the optional `#version` header, each "a b". */
	merges: string[];
}

/**
 * Minimal byte-level BPE encoder. Deliberately not a general tokenizer: no
 * normalization, no added tokens, no post-processing — LANCET frames windows with
 * explicit `<s>`/`</s>` ids instead of tokenizer special-token templates.
 */
export class CodeT5ByteLevelTokenizer {
	private readonly vocab: Record<string, number>;
	private readonly ranks: Record<string, number>;
	private readonly cache: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
	private readonly encoder = new TextEncoder();

	constructor(data: BpeTokenizerData) {
		// Prototype-free dictionaries: vocab tokens include `__proto__`-shaped strings.
		this.vocab = Object.create(null) as Record<string, number>;
		for (const [token, id] of Object.entries(data.vocab)) this.vocab[token] = id;
		this.ranks = Object.create(null) as Record<string, number>;
		for (let i = 0; i < data.merges.length; i++) {
			const line = data.merges[i].trim();
			if (!line || line.startsWith("#")) continue;
			this.ranks[line] = i;
		}
	}

	/** Encode to token ids (no special tokens added). */
	encode(text: string): number[] {
		const ids: number[] = [];
		for (const piece of text.match(PRE_TOKENIZE) ?? []) {
			const mapped = Array.from(this.encoder.encode(piece), (b) => BYTE_TO_UNICODE[b]).join("");
			for (const token of this.bpe(mapped)) {
				const id = this.vocab[token];
				// The shipped vocab is closed over the byte alphabet, so a miss means a
				// corrupt bundle rather than ordinary OOV text. Surfacing it as the unk
				// id would silently change the score; throw instead (caller escalates).
				if (id === undefined) throw new Error(`tokenizer: token ${JSON.stringify(token)} missing from vocab`);
				ids.push(id);
			}
		}
		return ids;
	}

	/** Reference BPE merge loop. */
	private bpe(token: string): string[] {
		const cached = this.cache[token];
		if (cached) return cached;
		let word = Array.from(token);
		if (word.length <= 1) {
			this.cache[token] = word;
			return word;
		}
		while (word.length > 1) {
			let bestRank = Number.POSITIVE_INFINITY;
			let bestIndex = -1;
			for (let i = 0; i < word.length - 1; i++) {
				const rank = this.ranks[`${word[i]} ${word[i + 1]}`];
				if (rank !== undefined && rank < bestRank) {
					bestRank = rank;
					bestIndex = i;
				}
			}
			if (bestIndex < 0) break;
			word = [...word.slice(0, bestIndex), word[bestIndex] + word[bestIndex + 1], ...word.slice(bestIndex + 2)];
		}
		this.cache[token] = word;
		return word;
	}
}

/** Decode ids back to text (test/debug helper; not used at inference time). */
export function decodeTokenIds(vocab: Record<string, number>, ids: number[]): string {
	const byId: Record<number, string> = {};
	for (const [token, id] of Object.entries(vocab)) byId[id] = token;
	const bytes: number[] = [];
	for (const id of ids) {
		const token = byId[id];
		if (token === undefined) continue;
		for (const ch of token) {
			const b = UNICODE_TO_BYTE[ch];
			if (b !== undefined) bytes.push(b);
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}
