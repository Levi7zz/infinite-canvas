import { NEW_API_BASE_URL, NEW_API_PROXY_PATH } from "@/constant/runtime-config";

const CANVAS_TOKEN_NAME = "无限画布";

type ApiEnvelope<T> = {
    success?: boolean;
    message?: string;
    code?: string;
    data?: T;
};

type NewApiStatus = {
    password_login_enabled?: boolean;
    password_login_encryption_enabled?: boolean;
    turnstile_check?: boolean;
};

type LoginBundle = {
    access_token?: string;
    session?: { sid?: string };
};

export type NewApiVerificationMethod = {
    method: "2fa" | "passkey" | string;
    available?: boolean;
    reason?: string;
};

export type NewApiLoginResult =
    | { kind: "authenticated"; accessToken: string; sessionId: string }
    | { kind: "verification"; flowToken: string; methods: NewApiVerificationMethod[] };

export class PasskeyVerificationCancelled extends Error {
    constructor(readonly alternativeRpIds: string[]) {
        super("Passkey verification was not completed");
        this.name = "PasskeyVerificationCancelled";
    }
}

type NewApiToken = {
    id?: number;
    name?: string;
    group?: string;
    status?: number;
    created_time?: number;
    expired_time?: number;
    remain_quota?: number;
    unlimited_quota?: boolean;
    model_limits_enabled?: boolean;
    model_limits?: unknown;
    allow_ips?: unknown;
    allow_user_quota_query?: boolean;
    auto_groups?: string[];
};

type NewApiTokenAutoGroups = { groups?: string[]; max_count?: number };
type NewApiUserGroups = Record<string, { desc?: string; ratio?: number | string } | string>;
type NewApiUser = { id: number; username: string; display_name?: string };

export function scaiGroupKind(group: string, description = "") {
    const kind = (value: string) => {
        if (/视频|\bvideos?\b/i.test(value)) return "video";
        if (/生图|图像|图片|绘图|\b(?:image|images|imagen|picture|photo)\b/i.test(value)) return "image";
    };
    return kind(group) || kind(description);
}

function bridgeUrl(path: string) {
    return `${NEW_API_PROXY_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestNewApi<T>(path: string, init: RequestInit = {}, accessToken = "") {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    const response = await fetch(bridgeUrl(path), { ...init, headers, credentials: "include", cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!response.ok || payload.success === false) {
        throw new Error(payload.message || payload.code || `ScAI 请求失败（${response.status}）`);
    }
    return payload;
}

function readStatus(payload: ApiEnvelope<NewApiStatus>) {
    return payload.data || {};
}

async function encryptPassword(password: string, publicKeyPem: string) {
    if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持安全登录，请直接打开 ScAI 登录");
    const body = publicKeyPem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\s+/g, "");
    const binary = atob(body);
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey("spki", bytes.buffer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, new TextEncoder().encode(password));
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

export async function loginNewApi(username: string, password: string): Promise<NewApiLoginResult> {
    const status = readStatus(await requestNewApi<NewApiStatus>("/api/status"));
    if (status.password_login_enabled === false) throw new Error("ScAI 已关闭账号密码登录");
    if (status.turnstile_check) throw new Error("当前启用了人机验证，请先在 ScAI 登录页面完成验证");

    let body: Record<string, string> = { username, password };
    if (status.password_login_encryption_enabled) {
        const keyPayload = await requestNewApi<{ enabled?: boolean; kid?: string; public_key?: string }>("/api/user/login/encryption-key");
        const key = keyPayload.data;
        if (!key?.enabled || !key.kid || !key.public_key) throw new Error("ScAI 登录加密配置不可用");
        body = { username, password_encrypted: await encryptPassword(password, key.public_key), encryption_key_id: key.kid };
    }

    const payload = await requestNewApi<LoginBundle | { require_verification?: boolean; flow_token?: string; methods?: NewApiVerificationMethod[] }>("/api/user/login?turnstile=", {
        method: "POST",
        body: JSON.stringify(body),
    });
    const data = payload.data;
    if (data && "require_verification" in data && data.require_verification && data.flow_token) {
        const methods = Array.isArray(data.methods) && data.methods.length ? data.methods : [{ method: "2fa", available: true }];
        return { kind: "verification", flowToken: data.flow_token, methods };
    }
    if (!data || !("access_token" in data) || !data.access_token) throw new Error(payload.message || "ScAI 登录失败");
    return { kind: "authenticated", accessToken: data.access_token, sessionId: data.session?.sid || "" };
}

export async function verifyNewApiLogin(flowToken: string, code: string): Promise<NewApiLoginResult> {
    const payload = await requestNewApi<LoginBundle>("/api/user/login/verify", {
        method: "POST",
        body: JSON.stringify({ flow_token: flowToken, method: "2fa", code }),
    });
    const data = payload.data;
    if (!data?.access_token) throw new Error(payload.message || "二次验证失败");
    return { kind: "authenticated", accessToken: data.access_token, sessionId: data.session?.sid || "" };
}

type PasskeyLoginBegin = {
    flow_token?: string;
    options?: unknown;
    publicKey?: unknown;
    response?: unknown;
    Response?: unknown;
    rp_ids?: string[];
};

function base64UrlToArrayBuffer(value: string | undefined | null) {
    if (!value) return new ArrayBuffer(0);
    const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.buffer;
}

function arrayBufferToBase64Url(value: ArrayBuffer | ArrayBufferLike | null | undefined) {
    if (!value) return "";
    const bytes = new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function preparePasskeyRequestOptions(payload: PasskeyLoginBegin) {
    const rawOptions = payload.publicKey || payload.options || payload.response || payload.Response;
    if (!rawOptions || typeof rawOptions !== "object") throw new Error("ScAI 未返回有效的 Passkey 参数");
    const options = (rawOptions as { publicKey?: unknown; PublicKey?: unknown; response?: unknown; Response?: unknown }).publicKey
        || (rawOptions as { PublicKey?: unknown }).PublicKey
        || (rawOptions as { response?: unknown }).response
        || (rawOptions as { Response?: unknown }).Response
        || rawOptions;
    if (!options || typeof options !== "object") throw new Error("ScAI 未返回有效的 Passkey 参数");
    const publicKey = { ...(options as Record<string, unknown>), challenge: base64UrlToArrayBuffer((options as { challenge?: string }).challenge) } as PublicKeyCredentialRequestOptions;
    if (Array.isArray((options as { allowCredentials?: Array<{ id?: string }> }).allowCredentials)) {
        publicKey.allowCredentials = (options as { allowCredentials: Array<{ id?: string; type?: string; [key: string]: unknown }> }).allowCredentials.map((item) => ({
            ...item,
            type: (item.type || "public-key") as PublicKeyCredentialType,
            id: base64UrlToArrayBuffer(item.id),
        }));
    }
    return publicKey;
}

function buildPasskeyAssertion(credential: PublicKeyCredential) {
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
        id: credential.id,
        rawId: arrayBufferToBase64Url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        response: {
            authenticatorData: arrayBufferToBase64Url(response.authenticatorData),
            clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
            signature: arrayBufferToBase64Url(response.signature),
            userHandle: response.userHandle ? arrayBufferToBase64Url(response.userHandle) : null,
        },
        clientExtensionResults: credential.getClientExtensionResults?.() || {},
    };
}

export async function verifyNewApiPasskey(flowToken: string, rpId?: string): Promise<NewApiLoginResult> {
    if (!globalThis.PublicKeyCredential || !navigator.credentials) throw new Error("当前浏览器不支持 Passkey");
    const beginPayload = await requestNewApi<PasskeyLoginBegin>("/api/user/login/passkey/begin", {
        method: "POST",
        body: JSON.stringify({ flow_token: flowToken, ...(rpId ? { rp_id: rpId } : {}) }),
    });
    const begin = beginPayload.data;
    if (!begin?.flow_token) throw new Error("ScAI 的 Passkey 验证流程已失效，请重新登录");
    const publicKey = preparePasskeyRequestOptions(begin);
    const alternativeRpIds = Array.isArray(begin.rp_ids)
        ? begin.rp_ids.filter((candidate): candidate is string => typeof candidate === "string" && candidate !== publicKey.rpId)
        : [];
    let credential: Credential | null;
    try {
        credential = await navigator.credentials.get({ publicKey });
    } catch (reason) {
        if (reason instanceof DOMException && reason.name === "NotAllowedError") throw new PasskeyVerificationCancelled(alternativeRpIds);
        throw reason;
    }
    if (!(credential instanceof PublicKeyCredential)) throw new Error("未取得 Passkey 凭据");
    const finishPayload = await requestNewApi<LoginBundle>("/api/user/login/passkey/finish", {
        method: "POST",
        body: JSON.stringify({ flow_token: flowToken, passkey_flow_token: begin.flow_token, credential: buildPasskeyAssertion(credential) }),
    });
    const data = finishPayload.data;
    if (!data?.access_token) throw new Error(finishPayload.message || "Passkey 验证失败");
    return { kind: "authenticated", accessToken: data.access_token, sessionId: data.session?.sid || "" };
}

function tokenItems(payload: ApiEnvelope<{ items?: NewApiToken[] } | NewApiToken[]>) {
    const data = payload.data;
    return Array.isArray(data) ? data : data?.items || [];
}

async function listTokens(accessToken: string) {
    const payload = await requestNewApi<{ items?: NewApiToken[] } | NewApiToken[]>(`/api/token/search?keyword=${encodeURIComponent(CANVAS_TOKEN_NAME)}`, {}, accessToken);
    return tokenItems(payload);
}

export async function provisionCanvasKey(accessToken: string, requireVideo = false) {
    const [autoPayload, userGroupsPayload, userPayload, tokens] = await Promise.all([
        requestNewApi<NewApiTokenAutoGroups>("/api/token/auto-groups", {}, accessToken),
        requestNewApi<NewApiUserGroups>("/api/user/self/groups", {}, accessToken),
        requestNewApi<NewApiUser>("/api/user/self", {}, accessToken),
        listTokens(accessToken),
    ]);
    const user = userPayload.data;
    if (!user?.id) throw new Error("无法读取 ScAI 账号信息，请重新登录");
    const userGroups = userGroupsPayload.data || {};
    const groups = (autoPayload.data?.groups || []).filter((group) => typeof group === "string" && group !== "auto" && Object.hasOwn(userGroups, group));
    const kind = (group: string) => {
        const details = userGroups[group];
        return scaiGroupKind(group, typeof details === "string" ? details : details?.desc);
    };
    const preferred = (capability: "video" | "image", exact: RegExp) => groups.find((group) => kind(group) === capability && exact.test(group)) || groups.find((group) => kind(group) === capability);
    const video = preferred("video", /^(视频生成|视频|video)$/i);
    const image = preferred("image", /^(图像生成|生图|image)$/i);
    if (requireVideo && !video) throw new Error("这个 ScAI 账号没有可用的视频分组");
    const autoGroups = groups.filter((group) => group === image || group === video);
    if (!autoGroups.length) throw new Error("这个 ScAI 账号没有可用的生图或视频分组");
    if (typeof autoPayload.data?.max_count === "number" && autoGroups.length > autoPayload.data.max_count) {
        if (!requireVideo || !video || autoPayload.data.max_count < 1) throw new Error("账号可绑定的分组数量不足，请在 ScAI 检查令牌设置");
        autoGroups.splice(0, autoGroups.length, video);
    }
    const groupRatios = Object.fromEntries(autoGroups.flatMap((group) => {
        const details = userGroups[group];
        const raw = typeof details === "object" && details ? details.ratio : undefined;
        const ratio = typeof raw === "number" || (/^\d+(?:\.\d+)?$/.test(raw || "")) ? Number(raw) : NaN;
        return Number.isFinite(ratio) && ratio >= 0 ? [[group, ratio]] : [];
    }));
    const account = { id: user.id, name: user.display_name || user.username, autoGroups, groupRatios, pricedAt: Date.now() };
    let token = selectCanvasToken(tokens);
    if (!token?.id) {
        await requestNewApi("/api/token/", {
            method: "POST",
            body: JSON.stringify({
                name: CANVAS_TOKEN_NAME,
                expired_time: -1,
                remain_quota: 0,
                unlimited_quota: true,
                group: "auto",
                cross_group_retry: true,
                auto_groups: autoGroups,
            }),
        }, accessToken);
        token = selectCanvasToken(await listTokens(accessToken));
    } else if (!token.auto_groups || autoGroups.length !== token.auto_groups.length || autoGroups.some((group, i) => group !== token?.auto_groups?.[i])) {
        await requestNewApi("/api/token/", {
            method: "PUT",
            body: JSON.stringify({
                id: token.id,
                name: token.name || CANVAS_TOKEN_NAME,
                status: token.status ?? 1,
                expired_time: token.expired_time ?? -1,
                remain_quota: token.remain_quota ?? 0,
                unlimited_quota: token.unlimited_quota ?? true,
                model_limits_enabled: token.model_limits_enabled ?? false,
                model_limits: token.model_limits,
                allow_ips: token.allow_ips,
                allow_user_quota_query: token.allow_user_quota_query ?? true,
                group: "auto",
                cross_group_retry: true,
                auto_groups: autoGroups,
            }),
        }, accessToken);
    }
    if (!token?.id) throw new Error("无限画布 Key 创建后未找到，请检查账号的令牌权限");
    const keyPayload = await requestNewApi<{ key?: string }>(`/api/token/${token.id}/key`, { method: "POST" }, accessToken);
    if (!keyPayload.data?.key) throw new Error("ScAI 未返回无限画布 Key");
    return { apiKey: keyPayload.data.key, account };
}

function selectCanvasToken(tokens: NewApiToken[]) {
    return tokens
        .filter((token) => token.name === CANVAS_TOKEN_NAME && token.group === "auto" && token.id && (token.status === undefined || token.status === 1))
        .sort((a, b) => (b.created_time || 0) - (a.created_time || 0))[0];
}

export async function logoutNewApi(accessToken: string, sessionId: string) {
    await requestNewApi("/api/user/auth/logout", {
        method: "POST",
        headers: sessionId ? { "x-auth-session": sessionId } : undefined,
    }, accessToken).catch(() => undefined);
}

export { CANVAS_TOKEN_NAME };
