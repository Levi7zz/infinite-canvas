import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN } from "@/lib/media-size";
import { estimateVideoPrice, isPublicVideoModel, isScaiBaseUrl, readVideoCapabilities, type ScaiPriceModel, type ScaiPricing } from "@/services/api/scai-pricing";
import { boolConfig, encodeChannelModel, modelOptionName, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { initialDraft, type StudioDraft } from "./studio-storage";

export type StudioModel = { id: string; name: string; row?: ScaiPriceModel; channel?: ModelChannel; quoteEligible: boolean };
export const manualResolutions = ["480", "720", "768", "1080", "2k", "4k"];

export function getStudioModels(config: AiConfig, pricing?: ScaiPricing): StudioModel[] {
    const publicModels = pricing?.models.filter((row) => isPublicVideoModel(pricing, row)) || [];
    const priceByModel = new Map(publicModels.map((row) => [row.model_name, row]));
    const connected = config.channels.flatMap((channel) => channel.baseUrl.trim() && channel.apiKey.trim() ? channel.models.flatMap((model) => {
        const scai = isScaiBaseUrl(channel.baseUrl);
        const row = scai ? priceByModel.get(model.name) : undefined;
        if (model.capability !== "video" && !(channel.scai && row)) return [];
        const standard = !model.script && (model.apiFormat || channel.apiFormat) === "openai";
        return [{ id: encodeChannelModel(channel.id, model.name), name: model.name, row: standard ? row : undefined, channel, quoteEligible: scai && standard }];
    }) : []);
    if (connected.length) return connected;
    const facts = { resolution: `${initialDraft.resolution}p`, seconds: Number(initialDraft.seconds), input_images: 0 };
    return publicModels.map((row) => ({ row, amount: estimateVideoPrice(pricing, row, facts)?.amount ?? Infinity }))
        .sort((a, b) => a.amount - b.amount || a.row.model_name.localeCompare(b.row.model_name))
        .map(({ row }) => ({ id: row.model_name, name: row.model_name, row, quoteEligible: true }));
}

export function selectStudioModel(models: StudioModel[], value: string) {
    return models.find((model) => model.id === value) || models.find((model) => model.name === modelOptionName(value) && model.quoteEligible);
}

export function studioModelLabel(model: string) {
    const name = modelOptionName(model);
    const known = name.match(/^(seedance|wan|(?:grok-imagine-video)|(?:minimax-h3))[-.]?(.*)$/i);
    if (!known) return name;
    const brand = { seedance: "Seedance", wan: "Wan", "grok-imagine-video": "Grok Imagine Video", "minimax-h3": "MiniMax H3" }[known[1].toLowerCase()];
    const suffix = known[2].match(/(?:^|-)([a-z])$/i);
    const version = (suffix ? known[2].slice(0, suffix.index).replace(/-$/, "") : known[2]).replace(/-video$/i, "").replace(/^(\d+)-(\d+)/, "$1.$2").replace(/-flash/i, " Flash").replace(/-/g, " ");
    return [brand, version, suffix ? `· 线路 ${suffix[1].toUpperCase()}` : ""].filter(Boolean).join(" ");
}

export function studioCapabilities(row?: ScaiPriceModel) {
    const caps = readVideoCapabilities(row);
    const min = Math.max(VIDEO_SECONDS_MIN, caps.duration?.[0] || VIDEO_SECONDS_MIN);
    const max = Math.max(min, Math.min(VIDEO_SECONDS_MAX, caps.duration?.[1] || VIDEO_SECONDS_MAX));
    const resolutions = caps.resolutions.map(parseVideoResolution);
    return { ...caps, resolutions, min, max };
}

export function constrainStudioDraft(draft: StudioDraft, row?: ScaiPriceModel) {
    const caps = studioCapabilities(row);
    const resolution = caps.resolutions.length && !caps.resolutions.includes(draft.resolution) ? (caps.resolutions.includes("720") ? "720" : caps.resolutions[0]) : draft.resolution;
    const seconds = String(Math.max(caps.min, Math.min(caps.max, Number(clampVideoSeconds(draft.seconds)))));
    return { ...draft, resolution, seconds };
}

export function studioDraftFromConfig(config: AiConfig, draft: StudioDraft): StudioDraft {
    return { ...draft, model: config.videoModel, ratio: inferVideoRatio(config.size), resolution: parseVideoResolution(config.vquality), seconds: config.videoSeconds, mode: config.videoMode === "reference" ? "reference" : "frames", audio: boolConfig(config.videoGenerateAudio, true), watermark: boolConfig(config.videoWatermark, false) };
}

export function studioRequest(config: AiConfig, draft: StudioDraft, model: StudioModel): AiConfig {
    return { ...config, model: model.id, videoModel: model.id, size: computeVideoSize(draft.resolution, draft.ratio), vquality: draft.resolution, videoSeconds: draft.seconds, videoMode: draft.images.length > 2 ? "reference" : draft.mode, videoGenerateAudio: String(draft.audio), videoWatermark: String(draft.watermark) };
}
