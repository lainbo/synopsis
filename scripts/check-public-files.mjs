import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

function git(args, cwd = process.cwd()) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    console.error("无法读取 Git 检查内容，请确认仓库、引用及暂存区有效。");
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 1 && args[0] === "--staged") ||
  (args.length === 2 && args[0] === "--ref" && args[1]))) {
  console.error("用法：pnpm check:public [--staged | --ref <提交或标签>]");
  process.exit(1);
}
const root = git(["rev-parse", "--show-toplevel"]).trim();
const mode = args[0] ?? "working-tree";
const label = mode === "--staged" ? "暂存区" : mode === "--ref" ? "指定提交快照" : "工作区";
let files;

if (mode === "working-tree") {
  files = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    .split("\0").filter(Boolean))].map((path) => ({ path }));
} else {
  const records = mode === "--staged"
    ? git(["ls-files", "--stage", "-z"], root)
    : git(["ls-tree", "-r", "-z", "--full-tree",
      git(["rev-parse", "--verify", "--end-of-options", `${args[1]}^{tree}`], root).trim()], root);
  files = records.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    const [permissions, second, third] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode === "--staged" && third !== "0") {
      console.error(`暂存区存在未解决的合并冲突：${JSON.stringify(path)}`);
      process.exit(1);
    }
    if (permissions === "160000") return [];
    return [{ path, oid: mode === "--staged" ? second : third }];
  });
}

const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:sk-or-v1-|sk-proj-|sk-ant-)[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/,
  /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/,
  /\b1\/\/[A-Za-z0-9_-]{30,}\b/
];
let failed = false;
for (const { path, oid } of files) {
  if (/(^|\/)(\.wrangler|\.ace-tool|\.VSCodeCounter)\//.test(path) ||
    /(^|\/)\.claude\/settings\.local\.json$/.test(path)) {
    console.error(`本机配置或运维记录不能发布：${path}`); failed = true;
    continue;
  }
  if (/(^|\/)(wrangler\.jsonc|wrangler\.local\..*|\.dev\.vars(?:\..*)?|\.env(?:\..*)?)$/.test(path) && !path.endsWith(".example")) {
    console.error(`私人配置不能发布：${path}`); failed = true;
    continue;
  }
  let content;
  if (oid) {
    // 按列出时的 Git 对象读取，工作区改写或删除不会改变检查内容。
    content = git(["cat-file", "blob", oid], root);
  } else {
    try {
      const absolute = join(root, path);
      content = (await lstat(absolute)).isSymbolicLink()
        ? await readlink(absolute) : await readFile(absolute, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      console.error(`无法读取待检查文件：${JSON.stringify(path)}`);
      failed = true;
      continue;
    }
  }
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (secrets.some((pattern) => pattern.test(lines[index]))) {
      console.error(`疑似凭据：${path}:${index + 1}（内容已隐藏）`); failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
else console.log(`${label}检查通过：未包含私人配置文件或常见格式的凭据。仍需人工检查自定义地址和敏感内容。`);
