import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

const OPENROUTER_MODELS_URL =
  process.env.OPENROUTER_MODELS_URL || "https://openrouter.ai/api/v1/models";
const WRANGLER_CONFIG_PATH = join(process.cwd(), "wrangler.jsonc");
const FIX = process.argv.includes("--fix");
const REASONING_CONFIG_COMMENT =
  "    // OPENROUTER_REASONING_EFFORT 和 OPENROUTER_REASONING_EXCLUDE 由 pnpm run deploy 根据 OpenRouter 模型接口能力自动维护，通常不要手动修改。";
const SUPPORTED_REASONING_EFFORTS = new Set([
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none"
]);

async function main() {
  const config = await readWranglerConfig();
  const vars = config.vars ?? {};
  const summaryProvider = parseSummaryProvider(vars.SUMMARY_PROVIDER);

  validateBaseUrl(vars[`${summaryProvider.toUpperCase()}_BASE_URL`]);
  if (summaryProvider === "openai") {
    if (!parseOptionalString(vars.OPENAI_MODEL)) fail("通用模式必须配置 OPENAI_MODEL。");
    if (vars.OPENAI_EXTRA_BODY) {
      let extra;
      try { extra = JSON.parse(vars.OPENAI_EXTRA_BODY); }
      catch { fail("OPENAI_EXTRA_BODY 必须是合法的 JSON 对象字符串。"); }
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) fail("OPENAI_EXTRA_BODY 必须是 JSON 对象。");
      if (["model", "messages", "stream"].some((key) => Object.hasOwn(extra, key))) {
        fail("OPENAI_EXTRA_BODY 不能覆盖 model、messages 或 stream。");
      }
    }
    console.log("通用 OpenAI 兼容模式配置检查通过；额外参数会原样发送。");
    return;
  }

  if (summaryProvider === "gemini") {
    const geminiModel = parseOptionalString(vars.GEMINI_MODEL);

    if (!geminiModel) {
      fail("SUMMARY_PROVIDER=gemini 时必须配置 GEMINI_MODEL。");
    }

    console.log("Gemini 模式配置检查通过。");
    console.log(`- Gemini 模型：${geminiModel}`);
    return;
  }

  const modelIds = collectModelIds(vars);
  const configuredReasoningEffort = parseOptionalString(vars.OPENROUTER_REASONING_EFFORT);

  if (!parseOptionalString(vars.OPENROUTER_MODEL)) {
    fail("OPENROUTER_MODEL 未配置，无法校验 OpenRouter 摘要模型。");
  }

  validateReasoningConfig(vars, configuredReasoningEffort);

  const models = await fetchOpenRouterModels();
  const missingModels = modelIds.filter((modelId) => !models.has(modelId));

  if (missingModels.length > 0) {
    fail(
      [
        "OpenRouter 模型配置校验失败：以下模型不存在或当前不可用：",
        ...missingModels.map((modelId) => `- ${modelId}`)
      ].join("\n")
    );
  }

  const unsupportedReasoningModels = modelIds.filter((modelId) => {
    const parameters = models.get(modelId)?.supportedParameters ?? [];

    return !parameters.includes("reasoning");
  });
  const allModelsSupportReasoning = unsupportedReasoningModels.length === 0;
  const desiredReasoningEffort = allModelsSupportReasoning
    ? configuredReasoningEffort ?? "minimal"
    : undefined;
  const desiredReasoningExclude = allModelsSupportReasoning
    ? parseBooleanString(vars.OPENROUTER_REASONING_EXCLUDE, true)
    : undefined;

  const updatedConfig = applyReasoningVars(config, {
    effort: desiredReasoningEffort,
    exclude: desiredReasoningExclude
  });

  if (JSON.stringify(updatedConfig.vars ?? {}) !== JSON.stringify(vars)) {
    if (!FIX) {
      fail("OpenRouter reasoning 配置需要调整。检查没有修改文件；pnpm run deploy 会自动调整本地私有配置后部署。");
    }
    await writeWranglerConfig(updatedConfig);
  }

  console.log("OpenRouter 模型配置校验通过：");
  console.log(`- 主模型：${modelIds[0]}`);

  if (modelIds[1]) {
    console.log(`- 备用模型：${modelIds[1]}`);
  }

  if (allModelsSupportReasoning) {
    console.log("- reasoning：启用");
    console.log(`- reasoning effort：${desiredReasoningEffort}`);
    console.log(`- reasoning exclude：${desiredReasoningExclude}`);
    console.log("- wrangler.jsonc：已确保 reasoning 配置与当前模型能力匹配");
  } else {
    console.log("- reasoning：关闭");
    console.log(
      [
        "- 不支持 reasoning 的模型：",
        ...unsupportedReasoningModels.map((modelId) => `  - ${modelId}`)
      ].join("\n")
    );
    console.log("- 本地配置与模型能力一致。");
  }
}

async function readWranglerConfig() {
  let text;

  try {
    text = await readFile(WRANGLER_CONFIG_PATH, "utf8");
  } catch (error) {
    fail(`无法读取 wrangler.jsonc：${formatError(error)}`);
  }

  try {
    const errors = [];
    const config = parseJsonc(text, errors, { allowTrailingComma: true });

    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(
        `${printParseErrorCode(first.error)} at offset ${first.offset}`
      );
    }

    return config;
  } catch (error) {
    fail(`wrangler.jsonc 不是合法 JSON/JSONC：${formatError(error)}`);
  }
}

function collectModelIds(vars) {
  return [
    parseOptionalString(vars.OPENROUTER_MODEL),
    parseOptionalString(vars.OPENROUTER_FALLBACK_MODEL)
  ].filter((modelId, index, modelIds) => modelId && modelIds.indexOf(modelId) === index);
}

async function writeWranglerConfig(config) {
  await writeFile(WRANGLER_CONFIG_PATH, addManagedReasoningComment(config));
}

function applyReasoningVars(config, reasoning) {
  const vars = { ...(config.vars ?? {}) };

  if (reasoning.effort) {
    vars.OPENROUTER_REASONING_EFFORT = reasoning.effort;
    vars.OPENROUTER_REASONING_EXCLUDE = String(reasoning.exclude ?? true);
  } else {
    delete vars.OPENROUTER_REASONING_EFFORT;
    delete vars.OPENROUTER_REASONING_EXCLUDE;
  }

  return { ...config, vars };
}

function addManagedReasoningComment(config) {
  const text = `${JSON.stringify(config, null, 2)}\n`;

  if (!config.vars?.OPENROUTER_REASONING_EFFORT) {
    return text;
  }

  const marker = '    "OPENROUTER_REASONING_EFFORT"';

  if (!text.includes(marker) || text.includes(REASONING_CONFIG_COMMENT)) {
    return text;
  }

  return text.replace(marker, `${REASONING_CONFIG_COMMENT}\n${marker}`);
}

function validateReasoningConfig(vars, reasoningEffort) {
  if (!reasoningEffort) {
    return;
  }

  if (!SUPPORTED_REASONING_EFFORTS.has(reasoningEffort)) {
    fail(
      `OPENROUTER_REASONING_EFFORT=${reasoningEffort} 不合法。允许值：${Array.from(
        SUPPORTED_REASONING_EFFORTS
      ).join(", ")}。`
    );
  }

  parseBooleanString(vars.OPENROUTER_REASONING_EXCLUDE, true);
}

async function fetchOpenRouterModels() {
  let response;

  try {
    response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(12000) });
  } catch (error) {
    fail(`无法请求 OpenRouter 模型列表：${formatError(error)}`);
  }

  if (!response.ok) {
    fail(`OpenRouter 模型列表请求失败：HTTP ${response.status}。`);
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    fail(`OpenRouter 模型列表响应不是合法 JSON：${formatError(error)}`);
  }

  if (!payload || !Array.isArray(payload.data)) {
    fail("OpenRouter 模型列表响应格式异常：缺少 data 数组。");
  }

  return new Map(
    payload.data
      .filter((model) => model && typeof model.id === "string")
      .map((model) => [
        model.id,
        {
          supportedParameters: Array.isArray(model.supported_parameters)
            ? model.supported_parameters.filter((parameter) => typeof parameter === "string")
            : []
        }
      ])
  );
}

function parseSummaryProvider(value) {
  const format = parseOptionalString(value)?.toLowerCase() ?? "openai";

  if (format === "openai" || format === "openrouter" || format === "gemini") {
    return format;
  }

  fail("SUMMARY_PROVIDER 只能配置为 openai、openrouter 或 gemini。");
}

function parseOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBooleanString(value, defaultValue) {
  const parsed = parseOptionalString(value);

  if (!parsed) {
    return defaultValue;
  }

  const normalized = parsed.toLowerCase();

  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  fail("OPENROUTER_REASONING_EXCLUDE 只能配置为 true/false 或 1/0。");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateBaseUrl(value) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    if (/\/(chat\/completions|generateContent)\/?$/.test(url.pathname)) throw new Error();
  } catch { fail("BASE_URL 必须是 HTTPS 基础地址，不含认证信息、查询参数和完整方法路径。"); }
}

await main();
