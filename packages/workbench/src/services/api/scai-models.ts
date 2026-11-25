import type { ChannelModel, ModelChannel, ModelGroup } from "@infinite-canvas/shared/channels";
import { SCAI_BASE_URL, SCAI_CHANNEL_ID, SCAI_GROUP_ID, SCAI_IMAGE_GROUP, SCAI_PROXY_PATH, SCAI_VIDEO_GROUP } from "@workbench/constant/scai";
import { guessCapability } from "@workbench/lib/model-utils";
import { channels } from "@workbench/services/channels/runtime";
import { channelWrites, createModelChannel, createModelGroup, updateChannels, useConfigStore } from "@workbench/stores/use-config-store";

type CatalogModel = { model_name: string; enable_groups?: string[] };

async function readCatalog(signal?: AbortSignal): Promise<Map<string, CatalogModel>> {
    try {
        const response = await fetch(`${SCAI_PROXY_PATH}/api/pricing`, { signal });
        if (!response.ok) return new Map();
        const payload = await response.json() as { data?: CatalogModel[] };
        return new Map(payload.data?.map((item) => [item.model_name, item]));
    } catch {
        signal?.throwIfAborted();
        return new Map();
    }
}

async function listScaiModels(channel: ModelChannel, group: ModelGroup, signal?: AbortSignal) {
    const [names, catalog] = await Promise.all([channels.listModels(channel, group, "openai", signal), readCatalog(signal)]);
    const existing = new Map(group.models.map((model) => [model.name, model]));
    return [...new Set(names)].flatMap((name): ChannelModel[] => {
        const upstreamGroups = catalog.get(name)?.enable_groups ?? [];
        const capability = upstreamGroups.some((item) => SCAI_VIDEO_GROUP.test(item)) ? "video"
            : upstreamGroups.some((item) => SCAI_IMAGE_GROUP.test(item)) ? "image"
            : /^minimax-h[\d.]+(?:-|$)/i.test(name) ? "video" : guessCapability(name);
        const current = existing.get(name);
        if (current) return [current];
        if (capability === "video") return [{ name, capability, scriptId: "openai-video" }];
        if (capability === "image") {
            const gemini = /^(?:gemini|imagen)(?:[-/]|$)|nano[-_ ]?banana/i.test(name);
            return [{ name, capability, scriptId: gemini ? "gemini-image" : "openai-image" }];
        }
        return [];
    });
}

function selectScaiChannel() {
    return useConfigStore.getState().config.channels.find((item) => item.id === SCAI_CHANNEL_ID);
}

export async function configureScaiChannel(apiKey: string) {
    await channelWrites.flush();
    const current = selectScaiChannel();
    const channel = createModelChannel({ id: SCAI_CHANNEL_ID, name: "ScAI", baseUrl: SCAI_BASE_URL });
    const existing = current?.groups.find((item) => item.id === SCAI_GROUP_ID && item.apiKey === apiKey);
    const group = createModelGroup({ ...existing, id: SCAI_GROUP_ID, name: "生图和视频", apiKey, hasApiKey: true });
    const models = await listScaiModels(channel, group);
    if (!models.length) throw new Error("该账号暂无可用的生图或视频模型");
    const all = useConfigStore.getState().config.channels;
    channel.groups = [{ ...group, models }, ...(current?.groups.filter((item) => item.id !== group.id) ?? [])];
    await updateChannels([...all.filter((item) => item.id !== channel.id), channel]);
    const state = useConfigStore.getState();
    if (state.isConfigOpen) {
        useConfigStore.setState({ configSelection: { tab: "builtin:channels", channelId: channel.id, groupId: group.id } });
    }
}

export async function refreshScaiModels(signal: AbortSignal) {
    await channelWrites.flush();
    const channel = selectScaiChannel();
    const group = channel?.groups.find((item) => item.id === SCAI_GROUP_ID);
    if (!channel || !group?.apiKey || channel.baseUrl !== SCAI_BASE_URL) throw new Error("请先登录 ScAI 完成配置");
    const models = await listScaiModels(channel, group, signal);
    signal.throwIfAborted();
    const all = useConfigStore.getState().config.channels;
    const latest = all.find((item) => item.id === channel.id);
    const latestGroup = latest?.groups.find((item) => item.id === group.id);
    if (!latest || !latestGroup || latest.baseUrl !== channel.baseUrl || latestGroup.apiKey !== group.apiKey) throw new Error("渠道已变更，请重新同步");
    const overrides = new Map(latestGroup.models.map((model) => [model.name, model]));
    const next = { ...latest, groups: latest.groups.map((item) => item === latestGroup ? { ...item, models: models.map((model) => overrides.get(model.name) ?? model) } : item) };
    await updateChannels(all.map((item) => item === latest ? next : item));
    return models.length;
}
