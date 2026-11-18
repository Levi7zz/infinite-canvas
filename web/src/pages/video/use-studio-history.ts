import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { createVideoGenerationTask, isVideoTaskFailed, storeGeneratedVideo, waitForVideoGenerationTask } from "@/services/api/video";
import { deleteStoredMedia } from "@/services/file-storage";
import { modelOptionName, resolveModelChannel, useConfigStore, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { readStudio, removeJob, writeJob, type StudioDraft, type StudioJob } from "./studio-storage";

type Submission = { draft: StudioDraft; config: AiConfig; channel: ModelChannel; quote?: StudioJob["quote"] };
type ActiveWork = { owner: string; controller: AbortController; id?: string };

export function useStudioHistory(owner: string, reportError: (error: string) => void) {
    const work = useRef<ActiveWork | null>(null);
    const [active, setActive] = useState<ActiveWork | null>(null);
    const [history, setHistory] = useState<{ owner: string; jobs: StudioJob[]; draft: StudioDraft | null; failed?: boolean }>();
    const loaded = history?.owner === owner ? history : undefined;
    const busy = active?.owner === owner;

    useEffect(() => {
        let current = true;
        void readStudio(owner).then((data) => {
            if (current) setHistory({ owner, ...data });
        }).catch(() => {
            if (current) setHistory({ owner, jobs: [], draft: null, failed: true });
        });
        return () => {
            current = false;
            if (work.current?.owner === owner) {
                work.current.controller.abort();
                work.current = null;
            }
        };
    }, [owner]);

    function begin(id?: string) {
        if (!loaded || loaded.failed || work.current) return;
        const operation = { owner, controller: new AbortController(), id };
        work.current = operation;
        setActive(operation);
        return operation;
    }

    function finish(operation: ActiveWork) {
        if (work.current !== operation) return;
        work.current = null;
        setActive(null);
    }

    function update(currentOwner: string, job: StudioJob) {
        setHistory((previous) => {
            if (previous?.owner !== currentOwner) return previous;
            const jobs = previous.jobs.some((item) => item.id === job.id)
                ? previous.jobs.map((item) => item.id === job.id ? job : item)
                : [job, ...previous.jobs];
            return { ...previous, jobs };
        });
    }

    async function save(operation: ActiveWork, job: StudioJob) {
        await writeJob(operation.owner, job);
        if (!operation.controller.signal.aborted) update(operation.owner, job);
    }

    async function poll(operation: ActiveWork, job: StudioJob, config: AiConfig) {
        if (!job.task || operation.controller.signal.aborted) return;
        let next: StudioJob;
        const signal = operation.controller.signal;
        try {
            const result = await waitForVideoGenerationTask(config, job.task, { signal });
            if (signal.aborted) return;
            const video = await storeGeneratedVideo(result);
            next = { ...job, status: "done", video, error: undefined };
        } catch (error) {
            if (signal.aborted) return;
            const failed = isVideoTaskFailed(error);
            next = { ...job, status: failed ? "failed" : "paused", error: failed && error instanceof Error ? error.message : undefined };
        }
        await save(operation, next).catch(() => {
            update(operation.owner, next);
            reportError("浏览器未能保存最新任务状态，请先下载已生成的视频。");
        });
    }

    async function query(job: StudioJob, silent = false) {
        if (!job.task || (job.task.provider === "plugin" && job.status !== "pending")) return;
        const config = useConfigStore.getState().config;
        const channel = config.channels.find((item) => item.baseUrl === job.baseUrl && item.apiKey.trim() && (item.id === job.channelId || (item.scai && owner === `scai:${item.scai.id}`)));
        if (!channel) {
            if (!silent) reportError("原渠道不可用。请恢复该任务所用的 ScAI 账号或渠道后继续查询。");
            return;
        }
        const operation = begin(job.id);
        if (!operation) return;
        try {
            const pending = { ...job, status: "pending" as const, error: undefined };
            await save(operation, pending);
            await poll(operation, pending, { ...config, channels: [channel] });
        } catch {
            if (!operation.controller.signal.aborted) reportError("浏览器未能保存任务状态。");
        } finally {
            finish(operation);
        }
    }

    const resumed = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!loaded || resumed.current === loaded.owner) return;
        resumed.current = loaded.owner;
        const pending = loaded.jobs.find((item) => item.status === "pending" && item.task);
        if (pending) void query(pending, true);
        // Resuming is tied to loading saved records, rather than each status update.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded?.owner]);

    async function submit(prepare: () => Promise<Submission | undefined>, onStart: (id: string) => void) {
        const operation = begin();
        if (!operation) return;
        const signal = operation.controller.signal;
        try {
            const submission = await prepare();
            if (!submission || signal.aborted) return;
            const { draft, config, channel, quote } = submission;
            const current = resolveModelChannel(useConfigStore.getState().config, config.model);
            const name = modelOptionName(config.model);
            const selected = current.models.find((item) => item.name === name);
            if (!selected || current.id !== channel.id || current.apiKey !== channel.apiKey || current.baseUrl !== channel.baseUrl || current.scai !== channel.scai || current.apiFormat !== channel.apiFormat || selected !== channel.models.find((item) => item.name === name)) {
                reportError("渠道已更新，请重新确认本次生成。");
                return;
            }
            const job: StudioJob = { id: nanoid(), createdAt: Date.now(), draft, channelId: channel.id, baseUrl: channel.baseUrl, quote, status: "submitting" };
            operation.id = job.id;
            await save(operation, job);
            if (signal.aborted) return;
            onStart(job.id);
            let task;
            try {
                // Let submission finish saving its ID even if the user navigates away.
                task = await createVideoGenerationTask(config, draft.prompt.trim(), draft.images);
            } catch (error) {
                await save(operation, { ...job, status: "unconfirmed", error: error instanceof Error ? error.message : undefined });
                return;
            }
            const pending = { ...job, task, status: "pending" as const };
            await save(operation, pending).catch(() => {
                update(operation.owner, pending);
                if (!signal.aborted) reportError("已收到任务编号，但浏览器未能保存。请留在此页等待结果。");
            });
            await poll(operation, pending, config);
        } catch {
            if (!signal.aborted) reportError("浏览器未能保存任务记录。");
        } finally {
            finish(operation);
        }
    }

    async function discard(job: StudioJob) {
        if (busy || job.status === "pending") return;
        try {
            await removeJob(owner, job.id);
            if (job.video?.storageKey) await deleteStoredMedia([job.video.storageKey]);
            setHistory((current) => current?.owner === owner ? { ...current, jobs: current.jobs.filter((item) => item.id !== job.id) } : current);
        } catch {
            reportError("浏览器未能删除任务记录。");
        }
    }

    return { loaded, busy, activeId: busy ? active?.id : undefined, submit, query, discard };
}
