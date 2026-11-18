import { App, Button, Input, Modal, Select, Switch, Tooltip } from "antd";
import { Aperture, ArrowRight, BookOpen, ChevronDown, ClipboardPaste, Clapperboard, Film, Images, LogIn, LogOut, Plus, RefreshCw, SlidersHorizontal, Upload, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { videoResolutionLabel } from "@/components/video-settings-panel";
import { parseVideoResolution, videoRatioOptions } from "@/lib/media-size";
import { applyScaiModelCapabilities, estimateVideoPrice, fetchScaiPricing, formatVideoEstimate, scaiPricingQueryKey } from "@/services/api/scai-pricing";
import { fetchChannelModelDefinitions } from "@/services/api/image";
import { videoRequestPriceFacts } from "@/services/api/video";
import { uploadImage } from "@/services/image-storage";
import { useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { constrainStudioDraft, getStudioModels, manualResolutions, selectStudioModel, studioCapabilities, studioDraftFromConfig, studioModelLabel, studioRequest, type StudioModel } from "./studio-models";
import { hydrateDraft, initialDraft, writeDraft, type StudioDraft, type StudioJob } from "./studio-storage";
import { StudioPreview, StudioWorks } from "./studio-results";
import { useStudioHistory } from "./use-studio-history";
import "./studio.css";

const examples = [
    { name: "电影运镜", prompt: "清晨的山间公路，一辆银色汽车驶过弯道。低机位从远处跟拍，镜头平稳推进，晨雾掠过山脊，冷暖光线交替，写实电影质感。" },
    { name: "商品展示", prompt: "一只哑光银色耳机放在黑色展台上。镜头绕主体缓慢旋转，柔和的轮廓光扫过表面，最后停在耳罩细节，干净的商业摄影风格。" },
    { name: "竖屏短片", ratio: "9:16", prompt: "雨后的街边咖啡店，杯子冒出丝丝热气。镜头从桌面缓缓抬起，窗外斑马线上的行人虚化掠过，竖屏构图，温暖自然光。" },
];
const externalSite = "https://scai.my";
const referenceLimit = 7; // Existing workbench limit.

export default function VideoPage() {
    const channels = useConfigStore((state) => state.config.channels);
    const loginOpen = useConfigStore((state) => state.isNewApiLoginOpen);
    const openLogin = useConfigStore((state) => state.openNewApiLoginDialog);
    const linked = channels.find((channel) => channel.scai && channel.apiKey.trim());
    const owner = linked?.scai ? `scai:${linked.scai.id}` : "local";
    const [transfer, setTransfer] = useState<StudioDraft>();

    useEffect(() => {
        if (!loginOpen && transfer) setTransfer(undefined);
    }, [loginOpen, transfer]);

    return <VideoStudio key={owner} owner={owner} accountChannel={linked} incomingDraft={linked ? transfer : undefined} login={(draft) => {
        if (!linked && (draft.prompt.trim() || draft.images.length)) setTransfer(draft);
        openLogin();
    }} />;
}

function VideoStudio({ owner, accountChannel, incomingDraft, login }: { owner: string; accountChannel?: ModelChannel; incomingDraft?: StudioDraft; login: (draft: StudioDraft) => void }) {
    const { message, modal } = App.useApp();
    const client = useQueryClient();
    const prices = useQuery({ queryKey: scaiPricingQueryKey, queryFn: ({ signal }) => fetchScaiPricing(signal) });
    const config = useConfigStore((state) => state.config);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const fileInput = useRef<HTMLInputElement>(null);
    const { loaded, busy, activeId, submit, query, discard } = useStudioHistory(owner, (error) => { void message.error(error); });
    const [guestDraft, setGuestDraft] = useState(incomingDraft);
    const [edited, setEdited] = useState<StudioDraft>();
    const [selectedId, setSelectedId] = useState<string>();
    const [refreshing, setRefreshing] = useState(false);
    const [comparison, setComparison] = useState(false);
    const [advanced, setAdvanced] = useState(false);
    const [promptsOpen, setPromptsOpen] = useState(false);
    const [assetsOpen, setAssetsOpen] = useState(false);
    const studioConfig = useMemo(() => accountChannel ? { ...config, channels: [accountChannel] } : config, [accountChannel, config]);
    const models = useMemo(() => getStudioModels(studioConfig, prices.data), [studioConfig, prices.data]);
    const scaiVideo = Boolean(accountChannel && models.some((option) => option.channel?.id === accountChannel.id));
    const defaults = accountChannel ? { ...initialDraft, model: config.videoModel } : config.videoModel ? studioDraftFromConfig(config, initialDraft) : initialDraft;
    const raw = edited || loaded?.draft || guestDraft || defaults;
    const model = selectStudioModel(models, raw.model || config.videoModel) || models[0];
    const selectionMissing = Boolean(raw.model && models.length && !selectStudioModel(models, raw.model));
    const draft = constrainStudioDraft(raw, model?.row);
    const caps = studioCapabilities(model?.row);
    const resolutionOptions = caps.resolutions.length ? caps.resolutions : Array.from(new Set([...manualResolutions, draft.resolution]));
    const request = model && studioRequest(studioConfig, draft, model);
    const facts = request && videoRequestPriceFacts(request, draft.images.length);
    const estimate = facts && estimateVideoPrice(prices.data, model?.row, facts, model?.channel);
    const selected = loaded?.jobs.find((job) => job.id === selectedId) || loaded?.jobs[0];
    const site = prices.data?.siteUrl || externalSite;
    const allowSubmit = Boolean(loaded && !loaded.failed && !selectionMissing && !busy && model && draft.prompt.trim());

    useEffect(() => {
        if (loaded && !loaded.failed && edited) void writeDraft(owner, edited).catch(() => { void message.warning("浏览器无法保存草稿"); });
    }, [edited, loaded?.owner, loaded?.failed, message, owner]);

    useEffect(() => {
        if (loaded && !loaded.failed && !loaded.draft && guestDraft) {
            setEdited((previous) => previous || guestDraft);
            setGuestDraft(undefined);
        }
    }, [loaded, guestDraft]);

    useEffect(() => {
        if (!videoCommand || !loaded) return;
        const next = useConfigStore.getState().config;
        setEdited((previous) => ({
            ...studioDraftFromConfig(next, previous || loaded.draft || initialDraft),
            prompt: videoCommand.prompt ?? previous?.prompt ?? loaded.draft?.prompt ?? "",
            model: next.videoModel || previous?.model || loaded.draft?.model || "",
        }));
        clearVideoCommand();
    }, [videoCommand, loaded, clearVideoCommand]);

    const patch = (settings: Partial<StudioDraft>) => setEdited((previous) => ({ ...(previous || raw), model: previous?.model || raw.model || model?.id || "", ...settings }));
    const changeModel = (id: string) => setEdited(constrainStudioDraft({ ...draft, model: id }, models.find((option) => option.id === id)?.row));

    async function addImages(files: Array<{ blob: Blob; name: string }>) {
        const supported = files.filter(({ blob }) => blob.type.startsWith("image/"));
        if (!supported.length) return void message.warning("请选择图片文件");
        if (draft.images.length >= referenceLimit) return void message.info(`最多 ${referenceLimit} 张参考图`);
        try {
            const next = await Promise.all(supported.slice(0, referenceLimit - draft.images.length).map(async ({ blob, name }) => {
                const image = await uploadImage(blob);
                return { id: nanoid(), name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }));
            setEdited((previous) => {
                const source = previous || raw;
                return { ...source, model: source.model || model?.id || "", images: [...source.images, ...next].slice(0, referenceLimit) };
            });
        } catch {
            void message.error("无法读取参考图");
        }
    }

    const addFiles = (files: FileList | null) => addImages(Array.from(files || [], (file) => ({ blob: file, name: file.name })));
    async function pasteImages() {
        try {
            const entries = await navigator.clipboard.read();
            const files = await Promise.all(entries.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map(async (type) => ({ blob: await item.getType(type), name: "剪贴板图片" }))));
            await addImages(files);
        } catch {
            void message.warning("无法读取剪贴板图片，请上传文件");
        }
    }

    async function useAsset(asset: InsertAssetPayload) {
        setAssetsOpen(false);
        if (asset.kind === "text") patch({ prompt: asset.content });
        else if (asset.kind === "image") {
            try {
                const image = await uploadImage(asset.dataUrl);
                patch({ images: [...draft.images, { id: nanoid(), name: asset.title, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey }].slice(0, referenceLimit) });
            } catch {
                void message.error("无法读取参考图");
            }
        }
    }

    async function refreshCatalog() {
        const channel = accountChannel || model?.channel;
        setRefreshing(true);
        try {
            const [catalog, definitions] = await Promise.allSettled([prices.refetch(), channel && fetchChannelModelDefinitions(channel)]);
            const fresh = catalog.status === "fulfilled" && !catalog.value.isError ? catalog.value.data : undefined;
            if (channel) {
                if (definitions.status === "rejected" || !definitions.value?.length) throw new Error("未能获取模型列表，已保留现有配置");
                const current = useConfigStore.getState().config.channels.find((item) => item.id === channel.id);
                if (!current || current.apiKey !== channel.apiKey || current.baseUrl !== channel.baseUrl) return;
                useConfigStore.getState().refreshChannelModels(channel.id, applyScaiModelCapabilities(definitions.value, fresh, current.scai?.autoGroups));
            }
            if (!fresh) return void message.warning("价格更新失败，请稍后重试");
            void message.success("模型和公开价目已更新");
        } catch (error) {
            void message.warning(error instanceof Error ? error.message : "模型更新失败");
        } finally {
            setRefreshing(false);
        }
    }

    async function generate() {
        if (!allowSubmit || !model || !request || !facts) return;
        const channel = model.channel;
        if (!channel) return login({ ...draft, model: model.id });
        if (draft.images.some((image) => !image.storageKey && !image.dataUrl)) return void message.warning("有参考图已不可用，请重新上传");
        const snapshot = { ...draft, model: model.id };
        return submit(async () => {
            const fresh = model.quoteEligible ? await client.fetchQuery({ queryKey: scaiPricingQueryKey, queryFn: ({ signal }) => fetchScaiPricing(signal), staleTime: 0 }).catch(() => undefined) : undefined;
            const row = fresh?.models.find((item) => item.model_name === model.name);
            if (fresh && model.row && !row) {
                void message.warning("该模型已不在最新价目中，请更新模型后重新选择");
                return;
            }
            const valid = constrainStudioDraft(snapshot, row);
            if (valid.resolution !== snapshot.resolution || valid.seconds !== snapshot.seconds) {
                void message.warning("该线路的可选规格已更新，请重新确认参数");
                return;
            }
            const latest = estimateVideoPrice(fresh, row, facts, channel);
            if (!latest || latest.scope === "public" || latest.signature !== estimate?.signature) {
                const previous = latest && estimate && latest.signature !== estimate.signature ? formatVideoEstimate(estimate) : undefined;
                const allowed = await modal.confirm({
                    title: previous ? "本次估价已更新" : latest?.scope === "account" ? "确认本次估价" : latest ? "确认使用参考价生成" : "暂无法估价",
                    content: latest ? `${previous ? `${previous} → ` : ""}${formatVideoEstimate(latest)}。实际扣费以 ScAI 账单为准。` : "这个线路或当前参数无法准确估价。继续生成仍可能扣费，实际金额以渠道账单为准。",
                    okText: "确认生成", cancelText: "返回修改", autoFocusButton: "cancel",
                });
                if (!allowed) return;
            }
            return { draft: snapshot, config: request, channel, quote: latest ? { amount: latest.amount, currency: latest.currency, scope: latest.scope } : undefined };
        }, setSelectedId);
    }

    function useExample(example: typeof examples[number]) {
        patch({ prompt: example.prompt, ...(example.ratio ? { ratio: example.ratio } : {}) });
        document.getElementById("studio-prompt")?.focus();
    }

    async function reuse(job: StudioJob) {
        if (draft.prompt.trim() && draft.prompt !== job.draft.prompt && !await modal.confirm({ title: "替换当前草稿？", content: "这会将作品的提示词和参数填入编辑区。", okText: "替换草稿", cancelText: "取消" })) return;
        try {
            setEdited(await hydrateDraft(job.draft));
            document.getElementById("studio-prompt")?.focus();
        } catch {
            void message.error("无法读取作品参数");
        }
    }

    function disconnect() {
        modal.confirm({ title: "断开 ScAI 账号？", content: "此浏览器会移除本次连接使用的 Key。用同一账号重新连接，即可查看之前保存在本机的作品。", okText: "断开连接", cancelText: "取消", onOk: () => accountChannel && useConfigStore.getState().disconnectScai(accountChannel.id) });
    }

    const renderPrice = (option: StudioModel) => facts && estimateVideoPrice(prices.data, option.row, facts, option.channel);

    return (
        <main className="scai-studio" aria-label="ScAI 视频工作室">
            <div className="studio-inner">
                <header className="studio-header">
                    <div className="studio-title"><span className="studio-mark"><Aperture size={23} /></span><h1>ScAI 视频工作室</h1></div>
                    <div className="studio-header-actions">
                        <Button type="text" icon={<RefreshCw size={15} />} loading={refreshing} disabled={busy} onClick={() => void refreshCatalog()}>更新模型</Button>
                        {accountChannel ? <>
                            <Button className="studio-account" disabled={busy} title="重新登录，更新账号倍率或切换账号" onClick={() => login(draft)}><i />{accountChannel.scai?.name}</Button>
                            <Tooltip title="断开连接"><Button type="text" aria-label="断开连接" icon={<LogOut size={16} />} onClick={disconnect} disabled={busy} /></Tooltip>
                        </> : <Button icon={<LogIn size={15} />} onClick={() => login(draft)}>登录 ScAI</Button>}
                    </div>
                </header>

                <div className="studio-grid">
                    <section className="studio-editor" aria-label="创建视频">
                        <div className="studio-section-heading"><span><Clapperboard size={16} /> 创作</span><div className="studio-reference-actions">
                            {guestDraft && loaded?.draft ? <Button type="link" size="small" onClick={() => { setEdited(guestDraft); setGuestDraft(undefined); }}>使用登录前的草稿</Button> : null}
                            <Tooltip title="新草稿"><Button type="text" size="small" aria-label="新草稿" icon={<Plus size={17} />} onClick={() => {
                                const reset = () => setEdited({ ...initialDraft, model: model?.id || "" });
                                if (draft.prompt.trim() || draft.images.length) modal.confirm({ title: "开始新草稿？", content: "这会清空当前画面描述和参考图。", okText: "清空草稿", cancelText: "取消", onOk: reset });
                                else reset();
                            }} /></Tooltip>
                        </div></div>
                        <div className="studio-fields">
                            <div className="studio-field">
                                <div className="studio-field-heading"><label htmlFor="studio-model">生成模型</label><button type="button" className="studio-text-action" onClick={() => setComparison(true)} disabled={!models.length}>比较价格 <ArrowRight size={13} /></button></div>
                                <Select id="studio-model" aria-label="生成模型" value={selectionMissing ? undefined : model?.id} showSearch optionFilterProp="label" placeholder={prices.isPending ? "正在读取模型…" : "请选择模型"} options={models.map((entry) => ({ value: entry.id, label: `${studioModelLabel(entry.name)}${!entry.quoteEligible && entry.channel ? ` · ${entry.channel.name}` : ""}` }))} onChange={changeModel} />
                                {selectionMissing ? <p className="studio-warning">草稿里的模型已不可用，请重新选择。</p> : null}
                                {accountChannel && !scaiVideo ? <p className="studio-warning">此账号暂无可用视频模型。</p> : null}
                                {prices.isError && !prices.data ? <p className="studio-warning">公开价目暂不可用。</p> : null}
                            </div>
                            <div className="studio-field">
                                <div className="studio-field-heading"><label htmlFor="studio-prompt">画面描述</label><Tooltip title="提示词库"><Button type="text" size="small" aria-label="提示词库" icon={<BookOpen size={15} />} onClick={() => setPromptsOpen(true)} /></Tooltip></div>
                                <Input.TextArea id="studio-prompt" value={draft.prompt} onChange={(event) => patch({ prompt: event.target.value })} rows={4} placeholder="例如：镜头缓缓靠近雨中的车窗，玻璃倒映着霓虹灯…" />
                            </div>
                            <div className="studio-field">
                                <div className="studio-field-heading"><span>参考图 <small>可选</small></span><div className="studio-reference-actions">
                                    <Tooltip title="从剪贴板粘贴"><Button type="text" size="small" aria-label="从剪贴板粘贴" icon={<ClipboardPaste size={15} />} onClick={() => void pasteImages()} /></Tooltip>
                                    <Tooltip title="从我的资产选择"><Button type="text" size="small" aria-label="从我的资产选择" icon={<Images size={15} />} onClick={() => setAssetsOpen(true)} /></Tooltip>
                                </div></div>
                                <div className="studio-references" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files); }}>
                                    {draft.images.map((image, index) => <div className="studio-reference" key={image.id}>
                                        {image.dataUrl ? <img src={image.dataUrl} alt={image.name} /> : <Images size={17} />}
                                        <button type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => patch({ images: draft.images.filter((ref) => ref.id !== image.id) })}><X size={12} /></button>
                                        {index > 0 ? <button type="button" className="studio-reference-order" aria-label={`将参考图 ${index + 1} 前移`} onClick={() => {
                                            const images = [...draft.images];
                                            [images[index - 1], images[index]] = [images[index], images[index - 1]];
                                            patch({ images });
                                        }}>{index + 1}</button> : null}
                                    </div>)}
                                    {draft.images.length < referenceLimit ? <button type="button" className="studio-upload" onClick={() => fileInput.current?.click()}><Upload size={16} />{draft.images.length ? "添加" : "上传图片"}</button> : null}
                                    <input hidden ref={fileInput} type="file" accept="image/*" multiple onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
                                </div>
                            </div>
                            <div className="studio-parameters">
                                <div className="studio-field"><label htmlFor="studio-resolution">清晰度</label><Select id="studio-resolution" value={draft.resolution} options={resolutionOptions.map((value) => ({ value, label: videoResolutionLabel(value) }))} onChange={(resolution: string) => patch({ resolution })} /></div>
                                <div className="studio-field"><label htmlFor="studio-seconds">时长</label><Select id="studio-seconds" value={draft.seconds} options={Array.from({ length: caps.max - caps.min + 1 }, (_, index) => ({ value: String(caps.min + index), label: `${caps.min + index} 秒` }))} onChange={(seconds: string) => patch({ seconds })} /></div>
                                <div className="studio-field"><label htmlFor="studio-ratio">比例</label><Select id="studio-ratio" value={draft.ratio} options={videoRatioOptions.map(({ value }) => ({ value, label: value === "auto" ? "自动" : value }))} onChange={(ratio: string) => patch({ ratio })} /></div>
                            </div>
                            <button type="button" className="studio-advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><SlidersHorizontal size={15} /> 更多设置 <ChevronDown size={14} className={advanced ? "studio-flipped" : ""} /></button>
                            {advanced ? <div className="studio-advanced">
                                {draft.images.length > 0 ? <label>图片模式 <Select aria-label="图片模式" disabled={draft.images.length > 2} value={draft.images.length > 2 ? "reference" : draft.mode} options={[{ value: "frames", label: "首尾帧" }, { value: "reference", label: "全能参考" }]} onChange={(mode: StudioDraft["mode"]) => patch({ mode })} /></label> : null}
                                {!caps.resolutions.length ? <label>自定义清晰度 <Input aria-label="自定义清晰度" placeholder="例如 960p" defaultValue={draft.resolution} key={model?.id} onBlur={(event) => patch({ resolution: parseVideoResolution(event.target.value) })} onPressEnter={(event) => event.currentTarget.blur()} /></label> : null}
                                <label>生成声音 <Switch size="small" checked={draft.audio} onChange={(audio) => patch({ audio })} /></label>
                                <label>添加水印 <Switch size="small" checked={draft.watermark} onChange={(watermark) => patch({ watermark })} /></label>
                            </div> : null}
                        </div>
                        <div className="studio-submit">
                            <div className="studio-quote" aria-live="polite">
                                <span>{estimate?.scope === "account" ? "账号预估" : estimate ? "公开参考价" : "本次费用"}</span>
                                <strong>{estimate ? formatVideoEstimate(estimate) : prices.isPending ? "读取中" : "暂无法估价"}</strong>
                            </div>
                            <button type="button" className="studio-generate" disabled={model?.channel ? !allowSubmit : busy} onClick={() => model?.channel ? void generate() : login({ ...draft, model: model?.id || draft.model })}>{busy ? "处理中…" : model?.channel ? <><Film size={17} />生成视频</> : <><LogIn size={17} />登录后生成</>}</button>
                            {model?.channel?.scai && estimate?.scope === "account" ? <span className="studio-quote-note" title={`账号价格更新于 ${new Date(model.channel.scai.pricedAt).toLocaleString("zh-CN")}`}>按上次登录的账号倍率估算 · 以账单为准</span> : null}
                            {loaded?.failed ? <span className="studio-warning">浏览器存储不可用，无法保存任务。</span> : null}
                        </div>
                    </section>

                    <StudioPreview job={selected} busy={busy} activeId={activeId} site={site} pricing={prices.data} accountChannel={accountChannel} onQuery={(job) => void query(job)} onReuse={(job) => void reuse(job)} onExample={useExample} examples={examples} />
                </div>

                <StudioWorks jobs={loaded?.jobs || []} selected={selected?.id} activeId={activeId} onSelect={setSelectedId} onDelete={(job) => modal.confirm({ title: "删除这条本机记录？", okText: "删除", okButtonProps: { danger: true }, cancelText: "取消", onOk: () => discard(job) })} />
            </div>

            <Modal title="比较本次费用" open={comparison} onCancel={() => setComparison(false)} footer={null} width={560}>
                <p className="mb-3 text-sm text-muted-foreground">{videoResolutionLabel(draft.resolution)} · {draft.seconds} 秒 · {draft.images.length} 张参考图</p>
                <div className="studio-compare-list">
                    {models.map((option) => ({ option, value: renderPrice(option) })).sort((a, b) => (a.value?.amount ?? Infinity) - (b.value?.amount ?? Infinity)).map(({ option, value }) => (
                        <button type="button" key={option.id} title={option.name} onClick={() => { changeModel(option.id); setComparison(false); }}>
                            <span>{studioModelLabel(option.name)} <small>{option.channel?.name}</small></span><span><b>{value ? formatVideoEstimate(value) : "暂无同规格估价"}</b><small>{value?.scope === "account" ? "账号预估" : value ? "公开参考价" : ""}</small></span>
                        </button>
                    ))}
                </div>
            </Modal>
            {promptsOpen ? <PromptSelectDialog open onOpenChange={setPromptsOpen} onSelect={(prompt) => patch({ prompt })} /> : null}
            {assetsOpen ? <AssetPickerModal open defaultTab="my-assets" onInsert={(asset) => void useAsset(asset)} onClose={() => setAssetsOpen(false)} /> : null}
        </main>
    );
}
