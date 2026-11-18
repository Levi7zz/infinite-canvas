import jsep from "jsep";

import { NEW_API_BASE_URL, NEW_API_PROXY_PATH } from "@/constant/runtime-config";
import { scaiGroupKind } from "@/services/new-api-auth";
import type { ChannelModel, ModelChannel } from "@/stores/use-config-store";

export type ScaiPriceModel = {
    model_name: string;
    description?: string;
    enable_groups: string[];
    billing_mode?: string;
    billing_expr?: string;
    billing_usage_schema?: Record<string, { enum?: unknown[] }>;
    billing_plugin_variants?: unknown[] | Record<string, unknown> | null;
};

type Currency = { type: string; factor: number; symbol?: string };
type PricingStatus = {
    quota_per_unit?: number;
    quota_display_type?: string;
    usd_exchange_rate?: number;
    custom_currency_symbol?: string;
    custom_currency_exchange_rate?: number;
    server_address?: string;
    theme?: string;
};

export type ScaiPricing = {
    models: ScaiPriceModel[];
    groupRatios: Record<string, number>;
    groupLabels: Record<string, string>;
    quotaPerUnit?: number;
    currency?: Currency;
    siteUrl?: string;
    classicUi?: boolean;
};

export type VideoPriceFacts = { resolution: string; seconds: number; input_images: number };
export type VideoEstimate = { amount: number; currency: Currency; scope: "account" | "public"; signature: string };

export const scaiPricingQueryKey = ["scai", "pricing"] as const;

async function readScai<T>(endpoint: string, signal?: AbortSignal) {
    const response = await fetch(`${NEW_API_PROXY_PATH}${endpoint}`, { credentials: "omit", cache: "no-store", signal });
    if (!response.ok) throw new Error(`ScAI ${response.status}`);
    return (await response.json()) as T;
}

export async function fetchScaiPricing(signal?: AbortSignal): Promise<ScaiPricing> {
    const [prices, statusResponse] = await Promise.all([
        readScai<{ success?: boolean; data?: ScaiPriceModel[]; group_ratio?: Record<string, number>; usable_group?: Record<string, string> }>("/api/pricing", signal),
        readScai<{ data?: PricingStatus }>("/api/status", signal).catch(() => undefined),
    ]);
    if (!prices.success || !Array.isArray(prices.data)) throw new Error("ScAI 定价暂不可用");
    const status = statusResponse?.data;
    const type = status?.quota_display_type;
    const factor = type === "USD" ? 1 : type === "CNY" ? status?.usd_exchange_rate : type === "CUSTOM" ? status?.custom_currency_exchange_rate : type === "TOKENS" ? status?.quota_per_unit : undefined;
    const currency = type && typeof factor === "number" && factor > 0 && Number.isFinite(factor) && (type !== "CUSTOM" || status?.custom_currency_symbol)
        ? { type, factor, symbol: type === "CUSTOM" ? status?.custom_currency_symbol : undefined }
        : undefined;
    return {
        models: prices.data.filter((model) => typeof model?.model_name === "string" && Array.isArray(model.enable_groups)),
        groupRatios: prices.group_ratio || {},
        groupLabels: prices.usable_group || {},
        quotaPerUnit: status?.quota_per_unit,
        currency,
        siteUrl: /^https?:\/\//i.test(status?.server_address || "") ? status?.server_address : undefined,
        classicUi: status?.theme === "classic",
    };
}

export function isScaiBaseUrl(baseUrl: string) {
    const withoutVersion = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "").toLowerCase();
    return withoutVersion(baseUrl) === withoutVersion(NEW_API_BASE_URL);
}

export function isPublicVideoModel(pricing: ScaiPricing, model: ScaiPriceModel) {
    return model.enable_groups.some((group) => scaiGroupKind(group, pricing.groupLabels[group]) === "video");
}

export function applyScaiModelCapabilities(models: ChannelModel[], pricing?: ScaiPricing, groups: string[] = []) {
    if (!pricing) return models;
    const byName = new Map(pricing.models.map((model) => [model.model_name, model]));
    return models.map((model) => {
        const kinds = new Set(byName.get(model.name)?.enable_groups
            .filter((group) => !groups.length || groups.includes(group))
            .map((group) => scaiGroupKind(group, pricing.groupLabels[group]))
            .filter(Boolean));
        const [capability] = kinds;
        if (!capability || kinds.size !== 1) return model;
        const apiFormat = capability === "video" ? "openai" : /^(?:gemini|imagen)(?:[-/]|$)/i.test(model.name) ? "gemini" : model.apiFormat;
        return { ...model, capability, apiFormat };
    });
}

export function readVideoCapabilities(model?: ScaiPriceModel) {
    const description = model?.description || "";
    const normalize = (value: string) => value.toLowerCase().trim();
    const metered = (model?.billing_usage_schema?.resolution?.enum || []).filter((value): value is string => typeof value === "string" && /^\s*(?:\d+p|[24]k)\s*$/i.test(value)).map(normalize);
    const described = (description.match(/(?:输出)?分辨率[：:]\s*([^，,；;]+)/)?.[1]?.match(/\d+p|[24]k/gi) || []).map(normalize);
    const resolutions = metered.length && described.length ? metered.filter((value) => described.includes(value)) : metered.length ? metered : described;
    const conflict = Boolean(metered.length && described.length && (metered.some((value) => !described.includes(value)) || described.some((value) => !metered.includes(value))));
    const duration = description.match(/时长[：:]\s*(\d+)\s*[-–~至]\s*(\d+)\s*(?:s|秒)/i);
    return { resolutions: Array.from(new Set(resolutions)), conflict, duration: duration ? [Number(duration[1]), Number(duration[2])] as const : undefined };
}

type Scalar = number | string | boolean;

// Only evaluate the task formula operations used here. No property access, variables or JavaScript execution.
function evaluate(node: jsep.Expression, facts: VideoPriceFacts): Scalar {
    switch (node.type) {
        case "Literal": {
            const value = (node as jsep.Literal).value;
            if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
            break;
        }
        case "CallExpression": {
            const { callee, arguments: args } = node as jsep.CallExpression;
            if (callee.type !== "Identifier" || args[0]?.type !== "Literal" || typeof args[0].value !== "string") break;
            if (callee.name === "u" && args.length === 1 && Object.hasOwn(facts, args[0].value)) return facts[args[0].value as keyof VideoPriceFacts];
            if (callee.name === "tier" && args.length === 2) return evaluate(args[1], facts);
            break;
        }
        case "ConditionalExpression": {
            const { test, consequent, alternate } = node as jsep.ConditionalExpression;
            const condition = evaluate(test, facts);
            if (typeof condition === "boolean") return evaluate(condition ? consequent : alternate, facts);
            break;
        }
        case "BinaryExpression": {
            const { left, operator, right } = node as jsep.BinaryExpression;
            const a = evaluate(left, facts);
            const b = evaluate(right, facts);
            if (operator === "==") return a === b;
            if (operator === "!=") return a !== b;
            if (typeof a !== "number" || typeof b !== "number") break;
            if (operator === "+") return a + b;
            if (operator === "-") return a - b;
            if (operator === "*") return a * b;
            if (operator === "/") return a / b;
            if (operator === "<") return a < b;
            if (operator === "<=") return a <= b;
            if (operator === ">") return a > b;
            if (operator === ">=") return a >= b;
            break;
        }
    }
    throw new Error("Unsupported ScAI billing formula");
}

export function evaluateVideoExpression(expression: string, facts: VideoPriceFacts) {
    try {
        const value = evaluate(jsep(expression), facts);
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

export function estimateVideoPrice(pricing: ScaiPricing | undefined, row: ScaiPriceModel | undefined, facts: VideoPriceFacts, channel?: ModelChannel): VideoEstimate | undefined {
    const currency = pricing?.currency;
    const quotaPerUnit = pricing?.quotaPerUnit;
    if (!pricing || !row || !currency || !quotaPerUnit || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0 || row.billing_mode !== "tiered_expr" || !row.billing_expr || (row.billing_plugin_variants && Object.keys(row.billing_plugin_variants).length)) return;
    const { resolutions, duration, conflict } = readVideoCapabilities(row);
    const metered = row.billing_usage_schema?.resolution?.enum;
    if (!metered?.length && !resolutions.length) return;
    if (metered?.length && !metered.some((value) => typeof value === "string" && value.toLowerCase().trim() === facts.resolution)) return;
    if (conflict && !resolutions.length) return;
    if (resolutions.length && !resolutions.includes(facts.resolution)) return;
    if (duration && (facts.seconds < duration[0] || facts.seconds > duration[1])) return;
    if (row.enable_groups.includes("all")) return;
    const account = channel?.scai;
    const available = account ? row.enable_groups.filter((group) => account.autoGroups.includes(group)) : row.enable_groups;
    if (available.length !== 1 || scaiGroupKind(available[0], pricing.groupLabels[available[0]]) !== "video") return;
    const group = available[0];
    const publicRatio = pricing.groupRatios[group];
    const accountRatio = account?.groupRatios[group];
    const ratio = accountRatio ?? publicRatio;
    const billedFacts = { ...facts, resolution: metered?.find((value): value is string => typeof value === "string" && value.toLowerCase().trim() === facts.resolution) || facts.resolution };
    const base = evaluateVideoExpression(row.billing_expr, billedFacts);
    if (base === undefined || !Number.isFinite(ratio) || ratio < 0) return;
    const declared = row.description?.match(/按(秒|次)计费/)?.[1];
    if (declared) {
        const other = evaluateVideoExpression(row.billing_expr, { ...billedFacts, seconds: facts.seconds + 1 });
        if (other === undefined || (declared === "秒" ? Math.abs(base - other) < 1e-9 : Math.abs(base - other) >= 1e-9)) return;
    }
    const quota = Math.round(base * quotaPerUnit * ratio);
    if (!Number.isSafeInteger(quota)) return;
    const amount = quota / quotaPerUnit * currency.factor;
    return { amount, currency, scope: accountRatio === undefined ? "public" : "account", signature: JSON.stringify([row.model_name, row.billing_expr, group, ratio, accountRatio !== undefined, facts, currency, quota]) };
}

export function formatVideoEstimate({ amount, currency }: Pick<VideoEstimate, "amount" | "currency">) {
    const maximumFractionDigits = amount > 0 && amount < 0.01 ? 6 : 2;
    if (currency.type === "CNY" || currency.type === "USD") return new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency.type, maximumFractionDigits }).format(amount);
    const value = new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(amount);
    return currency.type === "TOKENS" ? `${value} 额度` : `${currency.symbol || ""}${value}`;
}

type UsageLog = { type: number; quota: number; other?: string };

export function taskChargeFromLogs(logs: UsageLog[], taskId: string) {
    let initialSeen = false;
    let sum = 0;
    for (const log of logs) {
        if ((log.type !== 2 && log.type !== 6) || !Number.isSafeInteger(log.quota) || log.quota < 0 || !log.other) continue;
        try {
            const envelope = JSON.parse(log.other);
            const details = envelope?.public || envelope;
            if (details?.task_id !== taskId) continue;
            if (log.type === 2 && details.pre_consumed_quota === undefined && details.actual_quota === undefined) initialSeen = true;
            sum += log.type === 2 ? log.quota : -log.quota;
        } catch {
            continue;
        }
    }
    return initialSeen && Number.isSafeInteger(sum) && sum >= 0 ? sum : undefined;
}

export async function fetchScaiTaskCharge(apiKey: string, taskId: string) {
    const response = await fetch(`${NEW_API_PROXY_PATH}/api/log/token`, { credentials: "omit", cache: "no-store", headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw new Error(`ScAI ${response.status}`);
    const payload = (await response.json()) as { success?: boolean; data?: UsageLog[] };
    if (!payload.success || !Array.isArray(payload.data)) throw new Error("ScAI 账单不可用");
    return taskChargeFromLogs(payload.data, taskId);
}
