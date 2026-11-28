import { type FormEvent, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@infinite-canvas/plugin-sdk/ui/dialog";
import { Input } from "@infinite-canvas/plugin-sdk/ui/input";
import { workbenchMessageOptions } from "@workbench/components/ui/sonner";
import { SCAI_ENABLED } from "@workbench/constant/scai";
import { loginNewApi, logoutNewApi, PasskeyVerificationCancelled, provisionCanvasKey, verifyNewApiLogin, verifyNewApiPasskey, type NewApiLoginResult } from "@workbench/services/api/scai-auth";
import { configureScaiChannel } from "@workbench/services/api/scai-models";
import { useConfigStore } from "@workbench/stores/use-config-store";

type Verification = Extract<NewApiLoginResult, { kind: "verification" }>;
type Method = "2fa" | "passkey";

export function ScaiLoginDialog() {
    const { pathname } = useLocation();
    const open = useConfigStore((state) => state.isScaiLoginOpen);
    const settingsOpen = useConfigStore((state) => state.isConfigOpen);
    const hasChannel = useConfigStore((state) => state.config.channels.some(
        (channel) => channel.baseUrl && channel.groups.some((group) => group.apiKey && group.models.length),
    ));
    const prompted = useRef(false);
    useEffect(() => {
        const entry = pathname === "/" || pathname === "/create" || /^\/canvas(?:\/|$)/.test(pathname);
        if (!SCAI_ENABLED || !entry || prompted.current) return;
        prompted.current = true;
        if (!hasChannel && !settingsOpen) useConfigStore.setState({ isScaiLoginOpen: true });
    }, [pathname, hasChannel, settingsOpen]);
    return open ? <ScaiLoginForm backToSettings={settingsOpen} /> : null;
}

function ScaiLoginForm({ backToSettings }: { backToSettings: boolean }) {
    const [verification, setVerification] = useState<Verification | null>(null);
    const [method, setMethod] = useState<Method>("2fa");
    const [alternatives, setAlternatives] = useState<string[]>([]);
    const [rpId, setRpId] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const working = useRef(false);
    const returnFocus = useRef<HTMLElement | null>(null);
    const close = () => useConfigStore.setState({ isScaiLoginOpen: false });
    const returnToPassword = () => {
        setVerification(null);
        setAlternatives([]);
        setRpId("");
        setError("");
    };
    const canUse = (value: Method) => verification?.methods.some((item) => item.method === value && item.available !== false);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (working.current) return;
        const form = event.currentTarget;
        const values = new FormData(form);
        working.current = true;
        setBusy(true);
        setError("");
        let fallbackError = verification ? "验证失败，请重试" : "ScAI 登录失败，请检查账号和密码后重试";
        try {
            const pending = verification;
            let result: NewApiLoginResult;
            if (pending) {
                result = method === "passkey"
                    ? await verifyNewApiPasskey(pending.flowToken, rpId || undefined)
                    : await verifyNewApiLogin(pending.flowToken, String(values.get("code") ?? "").trim());
            } else {
                const username = String(values.get("username") ?? "").trim();
                const password = String(values.get("password") ?? "");
                if (!username || !password) throw new Error("请填写 ScAI 账号和密码");
                form.reset();
                result = await loginNewApi(username, password);
            }
            if (result.kind === "verification") {
                const supports = (item: Method) => result.methods.some((candidate) => candidate.method === item && candidate.available !== false);
                if (!supports("passkey") && !supports("2fa")) throw new Error("此账号需要额外验证，目前没有可用的验证方式");
                setMethod(supports("passkey") ? "passkey" : "2fa");
                setVerification(result);
                return;
            }
            fallbackError = "ScAI 配置失败，请重试";
            try {
                await configureScaiChannel(await provisionCanvasKey(result.accessToken));
            } finally {
                await logoutNewApi(result.accessToken, result.sessionId);
            }
            toast.success("ScAI 已配置", workbenchMessageOptions.success);
            close();
        } catch (reason) {
            if (reason instanceof PasskeyVerificationCancelled) {
                setAlternatives(reason.alternativeRpIds);
                setRpId(reason.alternativeRpIds[0] || "");
                setError("Passkey 验证已取消或超时，可以重试。");
            } else {
                const message = reason instanceof Error ? reason.message.replaceAll("New API", "ScAI") : "";
                setError(/\p{Script=Han}/u.test(message) ? message : fallbackError);
            }
        } finally {
            working.current = false;
            setBusy(false);
        }
    };

    return <Dialog open onOpenChange={(next) => { if (!next && !working.current) close(); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
            onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
            onCloseAutoFocus={(event) => {
                if (returnFocus.current?.isConnected) {
                    event.preventDefault();
                    returnFocus.current.focus();
                }
            }}>
            <DialogHeader>
                <DialogTitle>连接 ScAI</DialogTitle>
                <DialogDescription>使用 ScAI 账号登录。画布会按你的账号权限选择生图和视频分组，并将密钥保存在当前浏览器。</DialogDescription>
            </DialogHeader>
            <form onSubmit={(event) => void submit(event)} className="space-y-4" aria-busy={busy}>
                {!verification ? <fieldset disabled={busy} className="grid gap-3">
                    <label className="grid gap-1.5 text-sm">ScAI 账号<Input name="username" autoComplete="username" required /></label>
                    <label className="grid gap-1.5 text-sm">密码<Input name="password" type="password" autoComplete="current-password" required /></label>
                </fieldset> : <>
                    {canUse("2fa") && canUse("passkey") ? <div className="flex flex-wrap gap-2">
                        <Button type="button" variant={method === "passkey" ? "default" : "outline"} size="sm" disabled={busy} aria-pressed={method === "passkey"} onClick={() => { setMethod("passkey"); setError(""); }}>Passkey</Button>
                        <Button type="button" variant={method === "2fa" ? "default" : "outline"} size="sm" disabled={busy} aria-pressed={method === "2fa"} onClick={() => { setMethod("2fa"); setError(""); }}>验证码</Button>
                    </div> : null}
                    {method === "2fa" ? <label className="grid gap-1.5 text-sm">6 位验证码<Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} disabled={busy} required /></label>
                        : <div className="grid gap-2">
                            <p className="text-sm text-muted-foreground">使用你在 ScAI 绑定的 Passkey 验证。</p>
                            {alternatives.length > 1 ? <label className="grid gap-1.5 text-sm">Passkey 站点<select className="h-9 rounded-md border bg-background px-3" value={rpId} onChange={(event) => setRpId(event.target.value)} disabled={busy}>
                                {alternatives.map((value) => <option key={value} value={value}>{value}</option>)}
                            </select></label> : null}
                        </div>}
                </>}
                {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
                <DialogFooter>
                    {verification ? <Button type="button" variant="ghost" disabled={busy} onClick={returnToPassword}>返回登录</Button>
                        : <Button type="button" variant="ghost" disabled={busy} onClick={close}>{backToSettings ? "返回设置" : "稍后配置"}</Button>}
                    <Button type="submit" disabled={busy}>
                        {verification && method === "passkey" ? <KeyRound className="size-4" /> : null}
                        {busy ? "处理中…" : !verification ? "登录配置" : method === "passkey" ? "验证 Passkey" : "验证并配置"}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
