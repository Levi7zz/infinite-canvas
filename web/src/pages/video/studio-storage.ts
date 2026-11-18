import localforage from "localforage";

import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import type { VideoGenerationTask } from "@/services/api/video";
import type { VideoEstimate } from "@/services/api/scai-pricing";
import type { ReferenceImage } from "@/types/image";

export type StudioDraft = {
    prompt: string;
    model: string;
    resolution: string;
    ratio: string;
    seconds: string;
    mode: "frames" | "reference";
    audio: boolean;
    watermark: boolean;
    images: ReferenceImage[];
};

export const initialDraft: StudioDraft = { prompt: "", model: "", resolution: "720", ratio: "16:9", seconds: "6", mode: "frames", audio: true, watermark: false, images: [] };

export type StudioVideo = { url: string; storageKey: string; width?: number; height?: number; durationMs?: number; mimeType: string; bytes: number };

export type StudioJob = {
    id: string;
    createdAt: number;
    draft: StudioDraft;
    channelId: string;
    baseUrl: string;
    status: "submitting" | "pending" | "paused" | "done" | "failed" | "unconfirmed";
    task?: VideoGenerationTask;
    video?: StudioVideo;
    quote?: Pick<VideoEstimate, "amount" | "currency" | "scope">;
    error?: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "video_studio" });
const draftKey = (owner: string) => `draft:${owner}`;
const jobPrefix = (owner: string) => `job:${owner}:`;

function serializeDraft(draft: StudioDraft): StudioDraft {
    return { ...draft, images: draft.images.map((image) => image.storageKey ? { ...image, dataUrl: "" } : image) };
}

export async function hydrateDraft(draft: StudioDraft): Promise<StudioDraft> {
    const images = await Promise.all(draft.images.map(async (image) => ({ ...image, dataUrl: await resolveImageUrl(image.storageKey, image.dataUrl) })));
    return { ...draft, images };
}

export async function readStudio(owner: string) {
    const jobs: StudioJob[] = [];
    const [saved] = await Promise.all([
        store.getItem<StudioDraft>(draftKey(owner)),
        store.iterate<StudioJob, void>((job, key) => {
            if (key.startsWith(jobPrefix(owner))) jobs.push(job);
        }),
    ]);
    const draft = saved ? await hydrateDraft(saved) : null;
    return { draft, jobs: jobs.sort((a, b) => b.createdAt - a.createdAt) };
}

export function writeDraft(owner: string, draft: StudioDraft) {
    return store.setItem(draftKey(owner), serializeDraft(draft));
}

export function writeJob(owner: string, job: StudioJob) {
    const video = job.video;
    const storedVideo = video?.storageKey ? { ...video, url: "" } : undefined;
    return store.setItem(jobPrefix(owner) + job.id, { ...job, draft: serializeDraft(job.draft), video: storedVideo });
}

export function removeJob(owner: string, id: string) {
    return store.removeItem(jobPrefix(owner) + id);
}

export function resolveStudioVideo(video?: StudioVideo) {
    return video ? resolveMediaUrl(video.storageKey, video.url) : Promise.resolve("");
}
