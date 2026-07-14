import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertCircle, CheckCircle, X } from "lucide-react";

type ToastType = "success" | "error";

type ToastItem = {
    id: string;
    type: ToastType;
    message: string;
    exiting: boolean;
};

type ToastContextValue = {
    showToast: (type: ToastType, message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
        timers.current[id] = setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
            delete timers.current[id];
        }, 200);
    }, []);

    const showToast = useCallback(
        (type: ToastType, message: string) => {
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            setToasts((prev) => [...prev, { id, type, message, exiting: false }]);
            timers.current[id] = setTimeout(() => dismiss(id), 3500);
        },
        [dismiss],
    );

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className="toast-container" aria-live="polite" aria-atomic="false">
                {toasts.map((toast) => (
                    <div
                        key={toast.id}
                        className={`toast toast--${toast.type}${toast.exiting ? " toast--exit" : ""}`}
                        role="alert"
                    >
                        {toast.type === "success" ? (
                            <CheckCircle size={16} aria-hidden="true" />
                        ) : (
                            <AlertCircle size={16} aria-hidden="true" />
                        )}
                        <span className="toast-message">{toast.message}</span>
                        <button
                            className="toast-close"
                            type="button"
                            onClick={() => dismiss(toast.id)}
                            aria-label="Dismiss notification"
                        >
                            <X size={14} />
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used within ToastProvider");
    return ctx;
}
