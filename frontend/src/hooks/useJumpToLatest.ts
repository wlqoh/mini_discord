import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { Message } from "../types/chat.ts";

// Порог «прилипания» к низу — то же значение, что использовалось в ChatPage
// до выделения этого хука, менять его нельзя без пересмотра автоскролла.
const STICK_THRESHOLD_PX = 100;
// Порог показа кнопки. Больше порога прилипания, чтобы получился гистерезис:
// кнопка появляется на 200px, а исчезает только на 100px — иначе на границе
// она дребезжит при каждом мелком движении колеса.
const SHOW_THRESHOLD_PX = 200;
// Дальше двух экранов smooth-анимация ощущается как лаг — прыгаем мгновенно.
const SMOOTH_MAX_SCREENS = 2;

type Params = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    messages: Message[];
    selectedChannelId: number;
    currentUserId: number | null;
};

export function useJumpToLatest({ containerRef, messages, selectedChannelId, currentUserId }: Params) {
    const isAtBottomRef = useRef(true);
    const [isVisible, setIsVisible] = useState(false);
    const [lastSeenId, setLastSeenId] = useState(0);

    // Reset on channel switch via the React-sanctioned "adjust state during
    // render" pattern (not an effect — calling setState synchronously inside
    // an effect body triggers an avoidable extra render). isAtBottomRef itself
    // doesn't need resetting here: ChatPage's own scroll-positioning layout
    // effect already sets it to true whenever the channel id changes, and
    // layout effects commit before this hook's regular effects run.
    const [trackedChannelId, setTrackedChannelId] = useState(selectedChannelId);
    if (selectedChannelId !== trackedChannelId) {
        setTrackedChannelId(selectedChannelId);
        setIsVisible(false);
        setLastSeenId(0);
    }

    const tailId = messages.length ? messages[messages.length - 1].id : 0;
    const tailIdRef = useRef(tailId);
    // Ref writes must happen in an effect, not during render (react-hooks/refs) —
    // this sync effect is declared before the ones that read tailIdRef so the
    // value is always current by the time they run in the same commit.
    useEffect(() => {
        tailIdRef.current = tailId;
    }, [tailId]);

    const measure = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;

        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distance < STICK_THRESHOLD_PX;

        isAtBottomRef.current = atBottom;
        // Пока пользователь у низа, «увиденное» едет за хвостом. В момент отрыва
        // значение замирает и становится точкой отсчёта для бейджа.
        if (atBottom) setLastSeenId(tailIdRef.current);
        setIsVisible((prev) => (prev ? distance >= STICK_THRESHOLD_PX : distance > SHOW_THRESHOLD_PX));
    }, [containerRef]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        let frame = 0;
        const onScroll = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                measure();
            });
        };

        el.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            el.removeEventListener("scroll", onScroll);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [containerRef, measure, selectedChannelId]);

    // Приход новых сообщений увеличивает scrollHeight без события scroll —
    // без этого кнопка не появится у пользователя, стоящего между порогами.
    useEffect(() => {
        measure();
    }, [measure, messages.length, selectedChannelId]);

    // Массив отсортирован по возрастанию id, поэтому идём с хвоста и обрываемся
    // на первом увиденном — O(число новых), а не O(всей загруженной истории).
    const newCount = useMemo(() => {
        if (!lastSeenId) return 0;
        let count = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.id <= lastSeenId) break;
            if (msg.author_id !== currentUserId) count++;
        }
        return count;
    }, [messages, lastSeenId, currentUserId]);

    const jumpToLatest = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;

        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        if (!prefersReducedMotion && distance < el.clientHeight * SMOOTH_MAX_SCREENS) {
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        } else {
            el.scrollTop = el.scrollHeight;
            // Ленивые картинки/медиа ниже могут догрузиться и сдвинуть низ —
            // добиваем позицию на следующем кадре.
            requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        }

        // Не ждём конца smooth-анимации: прилипание к новым сообщениям должно
        // работать сразу, иначе пришедшее во время анимации сообщение её сорвёт.
        isAtBottomRef.current = true;
        setIsVisible(false);
        setLastSeenId(tailIdRef.current);
    }, [containerRef]);

    return { isVisible, newCount, jumpToLatest, isAtBottomRef };
}
