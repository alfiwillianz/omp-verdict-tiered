/** 修正版:AST walk 只对 named 节点查白名单;(a) 按结构分类;灰区用 pi-permission 真实白名单回放 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SRC = fs.readFileSync(path.join(process.cwd(), "extensions/omp-verdict.ts"), "utf8");
const start = SRC.indexOf("const BASH_SAFE_UNCONDITIONAL");
const end = SRC.indexOf("// ============================================================================\n// 规则层:文件路径敏感度");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(SRC.slice(start, end));
const lib = new Function("path", "os", "\n" + js + "\nreturn { classifyBash };")(path, os) as { classifyBash: (c: string) => { verdict: string; reason?: string } };

// pi-permission 白名单(从其源码提取)
const P = process.env.PI_PERM_PKG + "/src/rules/builtins.ts"; // npm 解包目录,经 PI_PERM_PKG 环境变量传入
const PSRC = fs.readFileSync(P, "utf8");
function extractSet(name: string): Set<string> {
	const m = PSRC.match(new RegExp(`(?:const|export const) ${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
	if (!m) throw new Error(`${name} 未找到`);
	return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}
const THEIR_UNCOND = extractSet("BUILTIN_UNCONDITIONAL_SAFE");
const THEIR_COND = extractSet("CONDITIONAL_SAFE_COMMANDS");
console.log(`pi-permission 白名单:无条件 ${THEIR_UNCOND.size},条件 ${THEIR_COND.size}(本仓库:无条件 78)`);

// 会话采样
const sessRoot = path.join(os.homedir(), ".pi/agent/sessions");
const cutoff = Date.now() - 3 * 86400e3;
const commands: string[] = [];
let toolTotal = 0, bashTotal = 0;
for (const proj of fs.readdirSync(sessRoot)) {
	const dir = path.join(sessRoot, proj);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const f of fs.readdirSync(dir)) {
		const fp = path.join(dir, f);
		if (!f.endsWith(".jsonl") || fs.statSync(fp).mtimeMs < cutoff) continue;
		for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
			if (!line.includes('"toolCall"')) continue;
			try {
				const d = JSON.parse(line);
				const msg = d?.message;
				if (d?.type !== "message" || msg?.role !== "assistant") continue;
				for (const b of msg.content ?? []) {
					if (b?.type !== "toolCall") continue;
					toolTotal++;
					if (b.name === "bash") { bashTotal++; const c = b.arguments?.command; if (typeof c === "string" && c.trim()) commands.push(c); }
				}
			} catch { }
		}
	}
}

const ours = commands.map((c) => lib.classifyBash(c));
const { Parser, Language } = await import("web-tree-sitter");
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(process.env.TS_BASH_WASM + "/tree-sitter-bash.wasm") as never);
const ALLOWED_KINDS = new Set(["program", "list", "pipeline", "command", "command_name", "word", "string", "string_content", "raw_string", "number", "concatenation"]);
const ALLOWED_PUNCT = new Set(["&&", "||", ";", "|", '"', "'"]);
function isClean(cmd: string): { clean: boolean; kinds: string[] } {
	if (cmd.length > 65536) return { clean: false, kinds: ["too-long"] };
	try {
		const tree = parser.parse(cmd);
		if (tree.rootNode.hasError) return { clean: false, kinds: ["parse-error"] };
		const kinds: string[] = [];
		const walk = (n: any) => {
			if (n.isNamed && !ALLOWED_KINDS.has(n.type)) kinds.push(n.type); // 修正:仅 named 节点
			for (let i = 0; i < n.childCount; i++) {
				const c = n.child(i);
				if (c === null) continue;
				if (c.isNamed) walk(c);
				else if (!/^\s*$/.test(c.text) && !ALLOWED_PUNCT.has(c.text)) kinds.push(`tok:${c.text}`);
			}
		};
		walk(tree.rootNode);
		return { clean: kinds.length === 0, kinds: [...new Set(kinds)] };
	} catch (e) { return { clean: false, kinds: [`throw`] }; }
}
const ast = commands.map((c) => isClean(c));

// (a) 安全增量分类:allow ∧ unclean,按 kind 归组;重定向再按目标路径分级
const SENSITIVE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.env|credentials?|id_rsa|\.pem|authorized_keys)(\/|$)|^\/(etc|usr|var|System|Library\/LaunchAgents)(\/|$)|_history$|~\/\.(bashrc|zshrc|profile|gitconfig)/i;
function classifyRedirect(cmd: string): "敏感目标" | "项目内/dev-null" | "无重定向" {
	if (!/[^>]\s*>{1,2}\s*/.test(cmd) && !/\d>&\d/.test(cmd)) return "无重定向";
	const targets = [...cmd.matchAll(/(?:\d*)>>?\s*(\S+)/g)].map((m) => m[1]);
	const anySensitive = targets.some((t) => SENSITIVE.test(t.replace(/^["']|["']$/g, "")));
	return anySensitive ? "敏感目标" : "项目内/dev-null";
}
type Bucket = { n: number; samples: string[] };
const aBuckets: Record<string, Bucket> = {};
let aTotal = 0, aSensitiveRedirect = 0;
for (let i = 0; i < commands.length; i++) {
	if (ours[i].verdict !== "allow" || ast[i].clean) continue;
	aTotal++;
	const kinds = ast[i].kinds.filter((k) => k !== "redirected_statement" && k !== "file_descriptor" && k !== "file_redirect");
	const other = kinds.length ? kinds.join("+") : "仅重定向";
	const key = ast[i].kinds.includes("file_redirect") ? `重定向(${classifyRedirect(commands[i])})` + (other !== "仅重定向" ? `+${other}` : "") : other;
	(aBuckets[key] ??= { n: 0, samples: [] }).n++;
	if (aBuckets[key].samples.length < 3) aBuckets[key].samples.push(commands[i]);
	if (ast[i].kinds.includes("file_redirect") && classifyRedirect(commands[i]) === "敏感目标") aSensitiveRedirect++;
}
console.log(`\n(a) 安全增量(本层放行 ∧ AST 不干净,修正后):${aTotal} 条`);
for (const [k, v] of Object.entries(aBuckets).sort((x, y) => y[1].n - x[1].n)) {
	console.log(`    ${String(v.n).padStart(3)}  ${k}`);
	for (const s of v.samples) console.log(`         ${s.slice(0, 88).replace(/\n/g, "⏎")}`);
}
console.log(`    其中重定向到敏感路径:${aSensitiveRedirect} 条(真正的安全洞)`);

// (b) 灰区吸收:两层近似——AST 干净 ∧ 他们的白名单(带引号剥离的首词匹配)
function theirWhitelistAllows(cmd: string): boolean {
	// 近似:每个 pipeline 段的首词(剥引号/赋值前缀/路径)须在其无条件集;未复刻其 160 行条件规则 → 下界
	for (const seg of cmd.split(/&&|\|\||[;|]/)) {
		const t = seg.trim().replace(/^\\\w+=\w+\s+/, "").split(/\s+/).filter(Boolean);
		if (!t.length) continue;
		const head = t[0].replace(/^["']|["']$/g, "").split("/").pop() ?? "";
		if (!THEIR_UNCOND.has(head)) return false;
	}
	return true;
}
let bAstOnly = 0, bAstPlusTheirs = 0, bTheirsSamples: string[] = [];
for (let i = 0; i < commands.length; i++) {
	if (ours[i].verdict !== "gray") continue;
	if (ast[i].clean) bAstOnly++;
	if (ast[i].clean && theirWhitelistAllows(commands[i])) { bAstPlusTheirs++; if (bTheirsSamples.length < 6) bTheirsSamples.push(commands[i]); }
}
const grayN = ours.filter((v) => v.verdict === "gray").length;
console.log(`\n(b) 灰区(本层) ${grayN} 条中的可吸收量:`);
console.log(`    AST 干净:${bAstOnly}(上限,还需白名单命中)`);
console.log(`    AST 干净 ∧ 其无条件白名单(下界近似):${bAstPlusTheirs}`);
for (const s of bTheirsSamples) console.log(`         ${s.slice(0, 88).replace(/\n/g, "⏎")}`);

// 灰区首词分布:白名单扩展的真实靶点
const grayHeads: Record<string, number> = {};
for (let i = 0; i < commands.length; i++) {
	if (ours[i].verdict !== "gray") continue;
	const segs = commands[i].split(/&&|\|\||[;|]/);
	for (const seg of segs) {
		const t = seg.trim().replace(/^\w+=\S+\s+/, "").split(/\s+/).filter(Boolean);
		if (!t.length) continue;
		const h = (t[0].replace(/^["']|["']$/g, "").split("/").pop() ?? "?").replace(/["']/g, "");
		grayHeads[h] = (grayHeads[h] ?? 0) + 1;
	}
}
console.log(`\n灰区首词 top15(白名单失配靶点):`);
for (const [k, v] of Object.entries(grayHeads).sort((x, y) => y[1] - x[1]).slice(0, 15)) console.log(`    ${String(v).padStart(3)}  ${k}`);
console.log(`\n(c) 吸收率总览:allow ${ours.filter(v=>v.verdict==="allow").length} / deny ${ours.filter(v=>v.verdict==="deny").length} / gray ${grayN}(bash 灰区率 ${(100*grayN/commands.length).toFixed(1)}%)`);
