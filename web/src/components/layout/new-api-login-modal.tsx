import { App, Alert, Button, Form, Input, Modal, Select } from "antd";
import { KeyRound, LogIn, ShieldCheck, WandSparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchChannelModelDefinitions } from "@/services/api/image";
import { loginNewApi, logoutNewApi, PasskeyVerificationCancelled, provisionCanvasKey, verifyNewApiLogin, verifyNewApiPasskey, type NewApiVerificationMethod } from "@/services/new-api-auth";
import { NEW_API_BASE_URL } from "@/constant/runtime-config";
import { useConfigStore } from "@/stores/use-config-store";

type Credentials = { username: string; password: string };
type VerificationMode = "2fa" | "passkey";

function readableError(reason: unknown, fallback: string) {
    return reason instanceof Error ? reason.message.replaceAll("New API", "ScAI") : fallback;
}

export function NewApiLoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const applyChannelModels = useConfigStore((state) => state.applyChannelModels);
    const [form] = Form.useForm<Credentials & { code: string }>();
    const [loading, setLoading] = useState(false);
    const [flowToken, setFlowToken] = useState("");
    const [verificationMethods, setVerificationMethods] = useState<NewApiVerificationMethod[]>([]);
    const [verificationMode, setVerificationMode] = useState<VerificationMode>("2fa");
    const [passkeyRpIds, setPasskeyRpIds] = useState<string[]>([]);
    const [passkeyRpId, setPasskeyRpId] = useState("");
    const [error, setError] = useState("");

    const reset = () => {
        form.resetFields();
        setFlowToken("");
        setVerificationMethods([]);
        setVerificationMode("2fa");
        setPasskeyRpIds([]);
        setPasskeyRpId("");
        setError("");
        setLoading(false);
    };

    const finish = () => {
        reset();
        onClose();
    };

    const configureCanvas = async (accessToken: string, sessionId: string) => {
        try {
            const apiKey = await provisionCanvasKey(accessToken);
            const result = importChannelCredentials({ baseUrl: NEW_API_BASE_URL, apiKey });
            if (!result.channelId) throw new Error(t("canvasAuth.setupFailed"));
            const channel = useConfigStore.getState().config.channels.find((item) => item.id === result.channelId);
            if (!channel) throw new Error(t("canvasAuth.setupFailed"));
            const models = await fetchChannelModelDefinitions(channel);
            if (!models.length) throw new Error(t("canvasAuth.noModels"));
            applyChannelModels(result.channelId, models);
            message.success(t("canvasAuth.success"));
            finish();
        } catch (reason) {
            setError(readableError(reason, t("canvasAuth.setupFailed")));
        } finally {
            await logoutNewApi(accessToken, sessionId);
        }
    };

    const completeVerification = async (result: Awaited<ReturnType<typeof verifyNewApiLogin>>) => {
        if (result.kind !== "authenticated") throw new Error(t("canvasAuth.verificationFailed"));
        await configureCanvas(result.accessToken, result.sessionId);
    };

    const handlePasskeyError = (reason: unknown) => {
        if (reason instanceof PasskeyVerificationCancelled) {
            setPasskeyRpIds(reason.alternativeRpIds);
            setPasskeyRpId(reason.alternativeRpIds[0] || "");
            setError(t("canvasAuth.passkeyCancelled"));
            return;
        }
        setError(readableError(reason, t("canvasAuth.passkeyFailed")));
    };

    const submitPasskey = async () => {
        if (!flowToken) return;
        setError("");
        setLoading(true);
        try {
            await completeVerification(await verifyNewApiPasskey(flowToken, passkeyRpId || undefined));
        } catch (reason) {
            handlePasskeyError(reason);
        } finally {
            setLoading(false);
        }
    };

    const submit = async (values: Credentials & { code: string }) => {
        setError("");
        setLoading(true);
        try {
            if (flowToken) {
                if (verificationMode === "passkey") {
                    try {
                        await completeVerification(await verifyNewApiPasskey(flowToken, passkeyRpId || undefined));
                    } catch (reason) {
                        if (reason instanceof PasskeyVerificationCancelled) {
                            setPasskeyRpIds(reason.alternativeRpIds);
                            setPasskeyRpId(reason.alternativeRpIds[0] || "");
                            throw new Error(t("canvasAuth.passkeyCancelled"));
                        }
                        throw reason;
                    }
                    return;
                }
                const result = await verifyNewApiLogin(flowToken, values.code?.trim() || "");
                await completeVerification(result);
                return;
            }
            const result = await loginNewApi(values.username.trim(), values.password);
            if (result.kind === "verification") {
                const availableMethods = result.methods.filter((method) => method.available !== false);
                if (!availableMethods.length) throw new Error(t("canvasAuth.verificationUnavailable"));
                setFlowToken(result.flowToken);
                setVerificationMethods(result.methods);
                const passkeyAvailable = availableMethods.some((method) => method.method.toLowerCase() === "passkey");
                setVerificationMode(passkeyAvailable ? "passkey" : "2fa");
                message.info(t(passkeyAvailable ? "canvasAuth.passkeyDescription" : "canvasAuth.verificationRequired"));
                return;
            }
            await configureCanvas(result.accessToken, result.sessionId);
        } catch (reason) {
            setError(readableError(reason, t("canvasAuth.loginFailed")));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal
            open={open}
            centered
            width={460}
            onCancel={finish}
            destroyOnHidden
            footer={null}
            title={
                <div>
                    <div className="flex items-center gap-2 text-lg font-semibold">
                        <WandSparkles className="size-5" />
                        {t("canvasAuth.title")}
                    </div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("canvasAuth.description")}</div>
                </div>
            }
        >
            <div className="space-y-4 pt-2">
                <div className="flex items-start gap-3 border-b border-stone-200 pb-4 dark:border-stone-800">
                    {flowToken ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-stone-500" /> : <KeyRound className="mt-0.5 size-4 shrink-0 text-stone-500" />}
                    <div className="text-xs leading-5 text-stone-500">{t(flowToken ? "canvasAuth.verificationDescription" : "canvasAuth.accountDescription")}</div>
                </div>
                {error ? <Alert type="error" showIcon message={error} /> : null}
                <Form form={form} layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}>
                    {flowToken ? (
                        <>
                            {verificationMethods.some((method) => method.method.toLowerCase() === "passkey" && method.available !== false) && verificationMethods.some((method) => method.method.toLowerCase() === "2fa" && method.available !== false) ? (
                                <div className="mb-4 flex gap-2">
                                    <Button type={verificationMode === "passkey" ? "primary" : "default"} onClick={() => setVerificationMode("passkey")}>
                                        {t("canvasAuth.passkeyLogin")}
                                    </Button>
                                    <Button type={verificationMode === "2fa" ? "primary" : "default"} onClick={() => setVerificationMode("2fa")}>
                                        {t("canvasAuth.verificationCode")}
                                    </Button>
                                </div>
                            ) : null}
                            {verificationMode === "passkey" ? (
                                <div className="rounded-lg border border-stone-200 px-3 py-3 dark:border-stone-800">
                                    <div className="text-sm font-medium">{t("canvasAuth.passkeyLogin")}</div>
                                    <div className="mt-1 text-xs leading-5 text-stone-500">{t("canvasAuth.passkeyDescription")}</div>
                                    {passkeyRpIds.length ? (
                                        <div className="mt-3">
                                            <label htmlFor="canvas-passkey-domain" className="mb-1 block text-xs text-stone-500">{t("canvasAuth.passkeyDomainLabel")}</label>
                                            <Select
                                                id="canvas-passkey-domain"
                                                className="w-full"
                                                value={passkeyRpId || undefined}
                                                onChange={setPasskeyRpId}
                                                options={passkeyRpIds.map((value) => ({ value, label: value }))}
                                            />
                                            <div className="mt-1 text-xs leading-5 text-stone-500">{t("canvasAuth.passkeyDomainHelp")}</div>
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                <Form.Item name="code" label={t("canvasAuth.verificationCode")} rules={[{ required: true, message: t("canvasAuth.verificationCodeRequired") }]}>
                                    <Input autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder={t("canvasAuth.verificationCodePlaceholder")} />
                                </Form.Item>
                            )}
                        </>
                    ) : (
                        <>
                            <Form.Item name="username" label={t("canvasAuth.username")} rules={[{ required: true, message: t("canvasAuth.usernameRequired") }]}>
                                <Input autoFocus autoComplete="username" placeholder={t("canvasAuth.usernamePlaceholder")} />
                            </Form.Item>
                            <Form.Item name="password" label={t("canvasAuth.password")} rules={[{ required: true, message: t("canvasAuth.passwordRequired") }]}>
                                <Input.Password autoComplete="current-password" placeholder={t("canvasAuth.passwordPlaceholder")} />
                            </Form.Item>
                        </>
                    )}
                    <div className="flex items-center justify-end gap-2">
                        <Button onClick={finish}>{t("common.cancel")}</Button>
                        <Button type="primary" htmlType={flowToken && verificationMode === "passkey" ? "button" : "submit"} onClick={flowToken && verificationMode === "passkey" ? () => void submitPasskey() : undefined} loading={loading} icon={<LogIn className="size-4" />}>
                            {t(flowToken ? (verificationMode === "passkey" ? "canvasAuth.passkeyLogin" : "canvasAuth.verify") : "canvasAuth.login")}
                        </Button>
                    </div>
                </Form>
            </div>
        </Modal>
    );
}
