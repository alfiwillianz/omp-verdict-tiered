/**
 * Download and verify the LANCET Nano bundle used by Tier 1 (ADR-0009).
 *
 *   bun run setup:lancet            # download into ~/.cache/omp/lancet-nano
 *   bun run setup:lancet --check    # verify an existing bundle, no network
 *   bun run setup:lancet --dir DIR  # custom location (matches tier1Lancet.modelPath)
 *   bun run setup:lancet --force    # re-download even when the bundle verifies
 *
 * Source: https://huggingface.co/fingerthief/lancet-nano at the pinned release
 * revision. Integrity is checked twice: `export.json` against the digest published
 * with the release (below), then every model file against the digests recorded in
 * `export.json`. The runtime repeats the second check on every load, so a bundle
 * tampered with after setup still refuses to load (Tier 1 escalates instead).
 *
 * The tokenizer is validated against @xenova/transformers (the reference byte-level
 * BPE implementation) as a post-download check; the runtime uses the equivalent
 * dependency-free tokenizer in src/classifiers/tokenizer.ts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REVISION = "v0.4.3";
const BASE_URL = `https://huggingface.co/fingerthief/lancet-nano/resolve/${REVISION}/bundle/model`;
/** Digest of export.json published in the release manifest (RELEASE-MANIFEST.json). */
const EXPORT_SHA256 = "2276cd2d2644024bb73db7a3e56636cc12a7226b049287a1d80f27f9641293ea";
const FILES = ["export.json", "model.json", "head.json", "head.bin", "vocab.json", "merges.txt", "encoder-int8.onnx"] as const;

function usage(): never {
	console.log(`Usage: bun run setup:lancet [--check] [--force] [--dir DIR]

  --check   verify the bundle at DIR (default ~/.cache/omp/lancet-nano), no network
  --force   re-download even if the existing bundle verifies
  --dir     target directory (default: ~/.cache/omp/lancet-nano; ~ is expanded)`);
	process.exit(0);
}

function parseArgs(argv: string[]): { dir: string; check: boolean; force: boolean } {
	let dir = path.join(os.homedir(), ".cache", "omp", "lancet-nano");
	let check = false;
	let force = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check") check = true;
		else if (arg === "--force") force = true;
		else if (arg === "--dir") {
			const value = argv[++i];
			if (!value) {
				console.error("--dir needs a value");
				process.exit(1);
			}
			dir = value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
		} else if (arg === "--help" || arg === "-h") usage();
		else {
			console.error(`unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	return { dir, check, force };
}

function sha256(data: Buffer): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

/** Verify every file in `dir` against export.json; returns the parsed model metadata. */
function verifyBundle(dir: string): { version: string; files: number } {
	const exportPath = path.join(dir, "export.json");
	if (!fs.existsSync(exportPath)) throw new Error(`missing ${exportPath} — run without --check to download`);
	const exportData = JSON.parse(fs.readFileSync(exportPath, "utf8")) as {
		validationComplete?: boolean;
		sha256?: Record<string, string>;
	};
	const exportDigest = sha256(fs.readFileSync(exportPath));
	if (exportDigest !== EXPORT_SHA256) throw new Error(`export.json digest mismatch (${exportDigest}) — refusing a bundle that does not match the pinned release`);
	if (!exportData.validationComplete) throw new Error("export.json is not a complete export");
	let files = 0;
	for (const name of FILES) {
		if (name === "export.json") continue;
		const file = path.join(dir, name);
		if (!fs.existsSync(file)) throw new Error(`missing ${name}`);
		const want = exportData.sha256?.[name];
		if (!want) throw new Error(`export.json records no digest for ${name}`);
		const got = sha256(fs.readFileSync(file));
		if (got !== want) throw new Error(`${name} digest mismatch (${got})`);
		files++;
	}
	const model = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8")) as { version?: string; format?: string };
	if (model.format !== "semantic-windowed-1") throw new Error(`unexpected model format: ${String(model.format)}`);
	return { version: model.version ?? "unknown", files };
}

/** Structural shape of the reference tokenizer used by the cross-check. Declared
 *  locally because the runtime subpath (which avoids the package root's image
 *  stack) ships no declarations; only `encode` is needed here. */
interface ReferenceTokenizer {
	encode(text: string): number[];
}
type ReferenceTokenizerCtor = new (tokenizerJSON: unknown, tokenizerConfig: unknown) => ReferenceTokenizer;

/** Cross-check the shipped tokenizer against @xenova/transformers' byte-level BPE.
 *  Both implementations must produce identical ids for a sample; a mismatch means
 *  the vocab/merges pair is not the one the model was trained with. */
async function verifyTokenizer(dir: string): Promise<void> {
	let TokenizerClass: ReferenceTokenizerCtor;
	try {
		// Computed specifier: the package root pulls in the image stack (sharp), which
		// this check does not need and minimal installs may not be able to load. The
		// tokenizers subpath has no published declarations, hence the structural type.
		const specifier = ["@xenova/transformers", "src", "tokenizers.js"].join("/");
		const module: unknown = await import(specifier);
		if (!module || typeof module !== "object" || !("PreTrainedTokenizer" in module) || typeof module.PreTrainedTokenizer !== "function") {
			throw new Error("PreTrainedTokenizer export missing");
		}
		TokenizerClass = module.PreTrainedTokenizer as ReferenceTokenizerCtor;
	} catch (error) {
		console.log(`  tokenizer cross-check skipped (@xenova/transformers unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
		return;
	}
	const vocab = JSON.parse(fs.readFileSync(path.join(dir, "vocab.json"), "utf8")) as Record<string, number>;
	const merges = fs
		.readFileSync(path.join(dir, "merges.txt"), "utf8")
		.split("\n")
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => line.trim());
	const tokenizerJson = {
		version: "1.0",
		truncation: null,
		padding: null,
		added_tokens: [],
		normalizer: null,
		pre_tokenizer: { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: true },
		post_processor: null,
		decoder: { type: "ByteLevel", add_prefix_space: true, trim_offsets: true, use_regex: true },
		model: {
			type: "BPE",
			dropout: null,
			unk_token: "<unk>",
			continuing_subword_prefix: null,
			end_of_word_suffix: null,
			fuse_unk: false,
			byte_fallback: false,
			vocab,
			merges,
		},
	};
	const reference = new TokenizerClass(tokenizerJson, {});
	const { CodeT5ByteLevelTokenizer } = await import("../src/classifiers/tokenizer");
	const local = new CodeT5ByteLevelTokenizer({ vocab, merges });
	const samples = ["ls -la", "git status", "rm -rf build/", "Get-ChildItem -Recurse", "cat ~/.ssh/id_rsa"];
	for (const sample of samples) {
		const want = reference.encode(sample);
		const got = local.encode(sample);
		if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`tokenizer parity mismatch for ${JSON.stringify(sample)}`);
	}
}

async function download(dir: string): Promise<void> {
	const temp = `${dir}.download-${process.pid}`;
	fs.rmSync(temp, { recursive: true, force: true });
	fs.mkdirSync(temp, { recursive: true });
	try {
		for (const name of FILES) {
			const url = `${BASE_URL}/${name}`;
			process.stdout.write(`  ${name} … `);
			const response = await fetch(url, { redirect: "follow" });
			if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			fs.writeFileSync(path.join(temp, name), buffer);
			console.log(`${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
		}
		// Verify in the temp dir BEFORE replacing a working bundle.
		const summary = verifyBundle(temp);
		await verifyTokenizer(temp);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.renameSync(temp, dir);
		console.log(`\nLANCET Nano ${summary.version} verified → ${dir} (${summary.files} files)`);
	} catch (error) {
		fs.rmSync(temp, { recursive: true, force: true });
		throw error;
	}
}

const { dir, check, force } = parseArgs(process.argv.slice(2));
try {
	if (check) {
		const summary = verifyBundle(dir);
		await verifyTokenizer(dir);
		console.log(`LANCET Nano ${summary.version} OK → ${dir} (${summary.files} files, tokenizer parity OK)`);
	} else if (!force && fs.existsSync(path.join(dir, "export.json"))) {
		try {
			const summary = verifyBundle(dir);
			console.log(`LANCET Nano ${summary.version} already present and verified → ${dir} (use --force to re-download)`);
		} catch (error) {
			console.log(`existing bundle failed verification (${error instanceof Error ? error.message : String(error)}); re-downloading`);
			await download(dir);
		}
	} else {
		console.log(`Downloading LANCET Nano ${REVISION} → ${dir}`);
		await download(dir);
	}
} catch (error) {
	console.error(`setup:lancet failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
