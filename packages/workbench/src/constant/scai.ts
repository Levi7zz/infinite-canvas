import type { RuntimeConfig } from "@infinite-canvas/shared/runtime";

const runtime = (globalThis as typeof globalThis & { __RUNTIME_CONFIG__?: RuntimeConfig }).__RUNTIME_CONFIG__;
const baseUrl = (runtime?.NEW_API_BASE_URL || import.meta.env?.VITE_NEW_API_BASE_URL || "").trim().replace(/\/+$/, "");
export const SCAI_BASE_URL = baseUrl || "https://api.scai.my";
const proxyPath = (runtime?.NEW_API_PROXY_PATH || import.meta.env?.VITE_NEW_API_PROXY_PATH || "/new-api").trim().replace(/\/+$/, "");
export const SCAI_PROXY_PATH = /^\/[\w-]+(?:\/[\w-]+)*$/.test(proxyPath) ? proxyPath : "/new-api";
export const SCAI_ENABLED = globalThis.location?.hostname === "canvas.scai.my" || Boolean(baseUrl);
export const SCAI_CHANNEL_ID = "scai-canvas";
export const SCAI_GROUP_ID = "scai-canvas-auto";
export const SCAI_IMAGE_GROUP = /生图|图片|图像|绘图|image|imagen|picture|photo/i;
export const SCAI_VIDEO_GROUP = /视频|video/i;
