import { useEffect, useRef } from "react";

export type ViewerImage = { url: string; alt: string };
export type ImageViewerState = { items: ViewerImage[]; index: number };

type Props = {
    state: ImageViewerState;
    isClosing: boolean;
    onClose: () => void;
    onIndexChange: (index: number) => void;
};

export default function ImageViewerModal({ state, isClosing, onClose, onIndexChange }: Props) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const previouslyFocusedRef = useRef<Element | null>(null);
    const hasMany = state.items.length > 1;
    const current = state.items[state.index];

    const goPrev = () => onIndexChange((state.index + state.items.length - 1) % state.items.length);
    const goNext = () => onIndexChange((state.index + 1) % state.items.length);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
                return;
            }
            if (!hasMany) return;
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                goPrev();
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                goNext();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [hasMany, state.index, state.items.length, onClose, onIndexChange]);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    useEffect(() => {
        previouslyFocusedRef.current = document.activeElement;
        containerRef.current?.focus();
        return () => {
            const previouslyFocused = previouslyFocusedRef.current;
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
                previouslyFocused.focus();
            }
        };
    }, []);

    return (
        <div
            className={`image-viewer-overlay ${isClosing ? "closing" : ""}`}
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Image viewer"
            tabIndex={-1}
            ref={containerRef}
        >
            <div className="image-viewer-content" onClick={(e) => e.stopPropagation()}>
                <img
                    key={current.url}
                    src={current.url}
                    alt={current.alt}
                    className="image-viewer-image"
                    onError={onClose}
                />
                {hasMany && (
                    <>
                        <button
                            type="button"
                            className="image-viewer-nav prev"
                            aria-label="Previous image"
                            onClick={(e) => {
                                e.stopPropagation();
                                goPrev();
                            }}
                        >
                            ‹
                        </button>
                        <button
                            type="button"
                            className="image-viewer-nav next"
                            aria-label="Next image"
                            onClick={(e) => {
                                e.stopPropagation();
                                goNext();
                            }}
                        >
                            ›
                        </button>
                        <div className="image-viewer-counter">
                            {state.index + 1} / {state.items.length}
                        </div>
                    </>
                )}
                <button type="button" className="image-viewer-close" onClick={onClose}>
                    Close
                </button>
            </div>
        </div>
    );
}
