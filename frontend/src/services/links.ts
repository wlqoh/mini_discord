// Зеркало internal/service/embed/urls.go — правки нужно вносить в оба места,
// иначе фронт подсветит одну ссылку, а превью придёт для другой.
export const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

const TRAILING_PUNCTUATION = ".,!?;:'\"";

/**
 * Отрезает знаки препинания, прилипшие к ссылке в живом тексте:
 * «смотри https://example.com/page.» — точка не часть адреса.
 */
export function trimUrlTail(raw: string): string {
    let url = raw;

    while (url.length > 0 && TRAILING_PUNCTUATION.includes(url[url.length - 1])) {
        url = url.slice(0, -1);
    }

    // Закрывающая скобка принадлежит ссылке, только если внутри неё же была
    // открывающая: «(см. https://ru.wikipedia.org/wiki/Go_(язык))».
    while (url.endsWith(")") && countChar(url, ")") > countChar(url, "(")) {
        url = url.slice(0, -1);
    }

    return url;
}

function countChar(value: string, char: string): number {
    let count = 0;
    for (const current of value) {
        if (current === char) count++;
    }
    return count;
}

/**
 * URL прокси картинки. Собирается на клиенте, потому что в деве фронт и бэк
 * живут на разных origin (VITE_API_URL=http://localhost:8080/api/v1), и
 * абсолютный путь с сервера был бы неверным.
 */
export function embedImageUrl(token: string): string {
    const base = (import.meta.env.VITE_API_URL || "/api/v1").replace(/\/$/, "");
    return `${base}/embeds/image/${encodeURIComponent(token)}`;
}

export function hostFromUrl(raw: string): string {
    try {
        return new URL(raw).hostname.replace(/^www\./, "");
    } catch {
        return raw;
    }
}
