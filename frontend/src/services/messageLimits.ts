// Дублирует maxMessageContentLen из internal/service/server/hub.go.
// Считаем именно кодовые точки ([...text].length), а не text.length:
// Go меряет длину рунами, а строковый .length в JS — единицами UTF-16,
// в которых эмодзи весит 2. Иначе клиент и сервер разошлись бы в оценке.
export const MAX_MESSAGE_CONTENT_LEN = 4000;

// Счётчик появляется только на подходе к лимиту — в обычной переписке его
// не должно быть видно вообще.
export const MESSAGE_LEN_COUNTER_THRESHOLD = 3600;

export function messageContentLength(text: string): number {
    return [...text].length;
}

export function isMessageContentTooLong(text: string): boolean {
    return messageContentLength(text.trim()) > MAX_MESSAGE_CONTENT_LEN;
}
