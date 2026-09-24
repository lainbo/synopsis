import { getSummaryProvider } from "./config";
import { generateOpenAISummary } from "./openai-summary";
import { generateGeminiSummary } from "./gemini-summary";
import { generateOpenRouterSummary } from "./openrouter-summary";
import type { Env } from "../types";

export type SummaryResult =
  | {
      ok: true;
      summary: string;
      privacyDowngraded: boolean;
      fallbackModelUsed: boolean;
      model: string;
    }
  | {
      ok: false;
      reason: string;
      detail?: string;
      privacyDowngraded: boolean;
      fallbackModelUsed: boolean;
      model?: string;
    };

export interface SummaryMailInput {
  to: string;
  text?: string;
  subject?: string;
}

export async function generateEmailSummary(
  env: Env,
  mail: SummaryMailInput
): Promise<SummaryResult> {
  let format: ReturnType<typeof getSummaryProvider>;

  try {
    format = getSummaryProvider(env);
  } catch {
    return {
      ok: false,
      reason: "summary_config_invalid",
      privacyDowngraded: false,
      fallbackModelUsed: false
    };
  }

  if (format === "gemini") {
    return generateGeminiSummary(env, mail);
  }

  return format === "openrouter"
    ? generateOpenRouterSummary(env, mail)
    : generateOpenAISummary(env, mail);
}
