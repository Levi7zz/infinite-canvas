import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { NewApiLoginModal } from "@/components/layout/new-api-login-modal";
import { useConfigStore } from "@/stores/use-config-store";

export function CanvasAuthGate() {
    const { pathname } = useLocation();
    const config = useConfigStore((state) => state.config);
    const isNewApiLoginOpen = useConfigStore((state) => state.isNewApiLoginOpen);
    const setNewApiLoginDialogOpen = useConfigStore((state) => state.setNewApiLoginDialogOpen);
    const [autoPrompted, setAutoPrompted] = useState(false);
    // The New API chat menu currently links to the canvas site root. Treat that
    // entry as a canvas route so first-time users see the setup dialog there too.
    const isCanvasRoute = pathname === "/" || pathname === "/canvas" || pathname.startsWith("/canvas/");
    const hasReadyChannel = config.channels.some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length > 0);

    useEffect(() => {
        if (!isCanvasRoute) {
            setAutoPrompted(false);
            return;
        }
        if (!hasReadyChannel && !autoPrompted) {
            setAutoPrompted(true);
            setNewApiLoginDialogOpen(true);
        }
    }, [autoPrompted, hasReadyChannel, isCanvasRoute, setNewApiLoginDialogOpen]);

    return <NewApiLoginModal open={isNewApiLoginOpen} onClose={() => setNewApiLoginDialogOpen(false)} />;
}
