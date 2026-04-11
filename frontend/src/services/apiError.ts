import type { AxiosError } from 'axios';

type ApiErrorBody = {
    error?: string;
    detail?: string;
    message?: string;
}

export function extractApiError(err: unknown, fallback: string): string {
    const axiosErr = err as AxiosError<ApiErrorBody | string>;
    const data = axiosErr.response?.data;

    if (typeof data === "string" && data.trim()) return data;

    if (data && typeof data === "object") {
        if (data.error) return data.error;
        if (data.detail) return data.detail;
        if (data.message) return data.message;
    }

    return fallback;
}