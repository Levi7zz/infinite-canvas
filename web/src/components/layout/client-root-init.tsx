import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { fetchChannelModelDefinitions } from "@/services/api/image";
import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

const SENSITIVE_CONFIG_PARAMS = ["baseUrl", "baseurl", "apiKey", "apikey", "import"];

export function readCredentialImportParams(location: Pick<Location, "search" | "hash">) {
    const query = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.replace(/^#\??/, ""));
    const hasFragmentCredentials = Boolean(fragment.get("baseUrl") || fragment.get("baseurl") || fragment.get("apiKey") || fragment.get("apikey"));
    const source = hasFragmentCredentials || fragment.get("import") === "1" ? fragment : query;
    return {
        baseUrl: source.get("baseUrl") || source.get("baseurl") || query.get("baseUrl") || query.get("baseurl"),
        apiKey: source.get("apiKey") || source.get("apikey") || query.get("apiKey") || query.get("apikey"),
        hasCredentials: Boolean(source.get("baseUrl") || source.get("baseurl") || source.get("apiKey") || source.get("apikey") || query.get("baseUrl") || query.get("baseurl") || query.get("apiKey") || query.get("apikey")),
    };
}

export function clearCredentialImportParams(location: Pick<Location, "pathname" | "search" | "hash">) {
    const search = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.replace(/^#\??/, ""));
    SENSITIVE_CONFIG_PARAMS.forEach((key) => {
        search.delete(key);
        fragment.delete(key);
    });
    const nextSearch = search.toString();
    const nextHash = fragment.toString();
    return `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${nextHash ? `#${nextHash}` : ""}`;
}

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const applyChannelModels = useConfigStore((state) => state.applyChannelModels);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        if (handledConfigParams.current) return;
        const { baseUrl, apiKey, hasCredentials } = readCredentialImportParams(window.location);
        if (!hasCredentials) return;
        handledConfigParams.current = true;
        window.history.replaceState(null, document.title, clearCredentialImportParams(window.location));
        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));

        if (!result.channelId || (result.status !== "created" && result.status !== "updated")) return;
        void (async () => {
            const channel = useConfigStore.getState().config.channels.find((item) => item.id === result.channelId);
            if (!channel || !channel.apiKey.trim()) return;
            try {
                const models = await fetchChannelModelDefinitions(channel);
                if (!models.length) {
                    message.warning(t("config.importedChannelModelsEmpty"));
                    return;
                }
                applyChannelModels(result.channelId!, models);
                message.success(t("config.importedChannelModelsFetched", { count: models.length }));
            } catch (error) {
                message.error(t("config.importedChannelModelsFailed", { error: error instanceof Error ? error.message : t("config.modelSelect.fetchFailed") }));
            }
        })();
    }, [applyChannelModels, importChannelCredentials, message, openConfigDialog, t]);

    return <>{children}</>;
}
