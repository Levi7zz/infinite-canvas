import { App, Button, Tooltip } from "antd";
import { ArrowRight, Clapperboard, Clock3, Copy, Download, ExternalLink, Film, FolderPlus, Layers, LoaderCircle, RefreshCw, TriangleAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { saveAs } from "file-saver";

import { videoResolutionLabel } from "@/components/video-settings-panel";
import { formatBytes } from "@/lib/image-utils";
import { fetchScaiTaskCharge, formatVideoEstimate, isScaiBaseUrl, type ScaiPricing } from "@/services/api/scai-pricing";
import { getMediaBlob, uploadMediaFile } from "@/services/file-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { studioModelLabel } from "./studio-models";
import { resolveStudioVideo, type StudioJob } from "./studio-storage";

type Example = { name: string; prompt: string; ratio?: string };

function displayStatus(job: StudioJob, activeId?: string) {
    switch (job.status) {
        case "pending": return activeId === job.id ? "生成中" : "等待查询";
        case "submitting": return activeId === job.id ? "正在提交" : "提交结果未确认";
        case "unconfirmed": return "提交结果未确认";
        case "paused": return "等待查询";
        case "done": return "已生成";
        case "failed": return "生成失败";
    }
}

export function StudioPreview({ job, activeId, busy, site, pricing, accountChannel, onQuery, onReuse, onExample, examples }: { job?: StudioJob; activeId?: string; busy: boolean; site: string; pricing?: ScaiPricing; accountChannel?: ModelChannel; onQuery: (job: StudioJob) => void; onReuse: (job: StudioJob) => void; onExample: (example: Example) => void; examples: readonly Example[] }) {
    return (
        <section className="studio-preview" aria-label="视频预览">
            <div className="studio-section-heading"><span><Film size={16} /> 预览</span><span className="studio-panel-meta">{job ? `${videoResolutionLabel(job.draft.resolution)} · ${job.draft.ratio === "auto" ? "自动比例" : job.draft.ratio} · ${job.draft.seconds}s` : "剪辑监看"}</span></div>
            {job ? <JobPreview key={job.id} job={job} active={activeId === job.id} busy={busy} site={site} pricing={pricing} accountChannel={accountChannel} onQuery={onQuery} onReuse={onReuse} /> : <>
                <div className="studio-screen studio-screen-empty">
                    <span className="studio-screen-mark studio-screen-tl" /><span className="studio-screen-mark studio-screen-tr" /><span className="studio-screen-mark studio-screen-bl" /><span className="studio-screen-mark studio-screen-br" />
                    <span className="studio-screen-code">预览</span><span className="studio-screen-timecode">00:00:00</span>
                    <div className="studio-screen-content"><Clapperboard size={33} strokeWidth={1.4} /><strong>暂无视频</strong></div>
                </div>
                <div className="studio-examples"><span>试一个灵感</span><div>{examples.map((example) => <button type="button" key={example.name} onClick={() => onExample(example)}>{example.name}<ArrowRight size={14} /></button>)}</div></div>
            </>}
        </section>
    );
}

function JobPreview({ job, active, busy, site, pricing, accountChannel, onQuery, onReuse }: { job: StudioJob; active: boolean; busy: boolean; site: string; pricing?: ScaiPricing; accountChannel?: ModelChannel; onQuery: (job: StudioJob) => void; onReuse: (job: StudioJob) => void }) {
    const { message } = App.useApp();
    const [source, setSource] = useState("");
    const [loadingCharge, setLoadingCharge] = useState(false);
    const [saving, setSaving] = useState(false);
    const [charge, setCharge] = useState<string>();
    const video = job.video;
    const status = displayStatus(job, active ? job.id : undefined);
    const canQuery = Boolean(job.task && job.task.provider !== "plugin" && (job.status === "paused" || job.status === "pending" || (job.status === "done" && (!video?.storageKey || !source))));
    const canCheckCharge = job.status === "done" && job.task?.provider === "openai" && isScaiBaseUrl(job.baseUrl);

    useEffect(() => {
        let current = true;
        void resolveStudioVideo(video).then((url) => { if (current) setSource(url); }).catch(() => { if (current) setSource(""); });
        return () => { current = false; };
    }, [video]);

    async function checkCharge() {
        if (!job.task || !pricing?.currency || !pricing.quotaPerUnit) return;
        const channel = accountChannel?.baseUrl === job.baseUrl ? accountChannel : useConfigStore.getState().config.channels.find((item) => item.id === job.channelId && item.baseUrl === job.baseUrl && item.apiKey);
        if (!channel) return void message.info("请用原账号连接后查看扣费");
        const { currency, quotaPerUnit } = pricing;
        setLoadingCharge(true);
        try {
            const quota = await fetchScaiTaskCharge(channel.apiKey, job.task.id);
            if (quota === undefined) return void message.info("这条任务的扣费记录暂不可确认，请查看 ScAI 账单");
            setCharge(formatVideoEstimate({ amount: quota / quotaPerUnit * currency.factor, currency }));
        } catch {
            void message.info("暂时无法读取扣费记录，请查看 ScAI 账单");
        } finally {
            setLoadingCharge(false);
        }
    }

    async function saveAsset() {
        if (!video?.storageKey || saving) return;
        setSaving(true);
        try {
            const blob = await getMediaBlob(video.storageKey);
            if (!blob) throw new Error();
            const saved = await uploadMediaFile(blob, "video");
            useAssetStore.getState().addAsset({ kind: "video", title: job.draft.prompt.slice(0, 26), coverUrl: "", tags: [], source: "ScAI 视频工作室", data: { ...saved, width: saved.width || 0, height: saved.height || 0 } });
            void message.success("已加入此浏览器的我的资产");
        } catch {
            void message.error("无法保存到我的资产");
        } finally {
            setSaving(false);
        }
    }

    const copyTask = async () => {
        if (!job.task) return;
        try {
            await navigator.clipboard.writeText(job.task.id);
            void message.success("已复制任务编号");
        } catch {
            void message.warning("未能复制，请从任务编号栏选择复制");
        }
    };

    return <>
        {source && job.status === "done" ? <div className="studio-screen"><video src={source} controls playsInline preload="metadata" onError={() => setSource("")} /></div> :
            <div className="studio-screen studio-screen-empty">
                <span className="studio-screen-mark studio-screen-tl" /><span className="studio-screen-mark studio-screen-tr" /><span className="studio-screen-mark studio-screen-bl" /><span className="studio-screen-mark studio-screen-br" />
                <div className="studio-screen-content" aria-live="polite">
                    {active ? <LoaderCircle size={28} className="animate-spin" /> : job.status === "failed" || job.status === "unconfirmed" || job.status === "submitting" ? <TriangleAlert size={27} /> : <Clock3 size={27} />}
                    <strong>{job.status === "done" ? "视频尚未保存到本机" : status}</strong>
                    {job.status === "paused" || (job.status === "pending" && !active) ? <p>可继续查询原任务，不会再次提交。</p> : null}
                    {(job.status === "unconfirmed" || (job.status === "submitting" && !active)) ? <p>请先检查任务记录和账单，再决定是否重新生成。</p> : null}
                    {job.error ? <p title={job.error}>{job.error}</p> : null}
                </div>
            </div>}
        <div className="studio-result-info">
            <div>
                <strong title={job.draft.prompt}>{job.draft.prompt}</strong>
                <span>{studioModelLabel(job.draft.model)}{video?.width && video?.height ? ` · ${video.width}×${video.height}` : ""}{video?.bytes ? ` · ${formatBytes(video.bytes)}` : ""}</span>
                <span>{job.quote ? `${job.quote.scope === "account" ? "提交时估价" : "提交时参考价"} ${formatVideoEstimate(job.quote)}` : "提交时未取得估价"}{charge ? ` · 已入账 ${charge}` : ""}</span>
                {source && !video?.storageKey ? <span className="studio-warning">临时预览，请及时下载。</span> : null}
            </div>
            <div className="studio-result-actions">
                {source && video ? <Button icon={<Download size={15} />} onClick={() => saveAs(source, `${job.draft.prompt.slice(0, 26).replace(/[\\/:*?"<>|]/g, "_") || "ScAI 视频"}.${video.mimeType.includes("webm") ? "webm" : "mp4"}`)}>下载</Button> : null}
                {source && video?.storageKey ? <Tooltip title="加入我的资产"><Button aria-label="加入我的资产" icon={<FolderPlus size={15} />} loading={saving} onClick={() => void saveAsset()} /></Tooltip> : null}
                {canQuery ? <Button icon={<RefreshCw size={15} />} loading={active} disabled={busy && !active} onClick={() => onQuery(job)}>查询原任务</Button> : null}
                <Button type="text" icon={<Layers size={15} />} onClick={() => onReuse(job)}>以此再创作</Button>
            </div>
        </div>
        <div className="studio-result-links">
            {job.task ? <Tooltip title="复制任务编号"><button type="button" onClick={() => void copyTask()} className="studio-text-action"><Copy size={13} /> <span className="studio-task-id">{job.task.id}</span></button></Tooltip> : null}
            {canCheckCharge && pricing?.currency && !charge ? <Button type="link" size="small" loading={loadingCharge} onClick={() => void checkCharge()}>查已入账金额</Button> : null}
            {isScaiBaseUrl(job.baseUrl) ? <a className="studio-text-action" href={`${site.replace(/\/$/, "")}${pricing?.classicUi ? "/console/log" : "/usage-logs"}`} target="_blank" rel="noreferrer">ScAI 账单 <ExternalLink size={13} /></a> : null}
        </div>
    </>;
}

export function StudioWorks({ jobs, selected, activeId, onSelect, onDelete }: { jobs: StudioJob[]; selected?: string; activeId?: string; onSelect: (id: string) => void; onDelete: (job: StudioJob) => void }) {
    return <section className="studio-works" aria-label="本机作品">
        <div className="studio-section-heading"><span><Layers size={16} /> 本机作品 <small>{jobs.length}</small></span><span className="studio-panel-meta">仅保存在此浏览器</span></div>
        {jobs.length ? <div className="studio-works-list">
            {jobs.map((item) => <div className="studio-work" key={item.id} data-selected={selected === item.id}>
                <button type="button" className="studio-work-open" aria-pressed={selected === item.id} onClick={() => onSelect(item.id)}>
                    <span className="studio-work-icon">{item.status === "done" ? <Film size={19} /> : <Clock3 size={18} />}</span>
                    <span className="studio-work-text"><strong>{item.draft.prompt}</strong><small>{studioModelLabel(item.draft.model)} · {videoResolutionLabel(item.draft.resolution)} · {item.draft.seconds}s</small></span>
                    <span className="studio-work-state">{displayStatus(item, activeId)}</span>
                </button>
                {item.id !== activeId && item.status !== "pending" ? <Tooltip title="删除记录"><Button aria-label="删除记录" type="text" size="small" icon={<Trash2 size={15} />} onClick={() => onDelete(item)} /></Tooltip> : null}
            </div>)}
        </div> : <div className="studio-empty-works">还没有作品</div>}
    </section>;
}
