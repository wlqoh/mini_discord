import { useMediaQuery } from "./useMediaQuery";

/**
 * Single source of truth for "phone layout". MUST stay in sync with the
 * `@media` query at the top of src/styles/mobile.css.
 */
export const MOBILE_QUERY = "(max-width: 768px), (max-height: 500px) and (pointer: coarse)";

export function useIsMobile(): boolean {
    return useMediaQuery(MOBILE_QUERY);
}

/** Devices without hover (touch): hover-only affordances must be replaced. */
export function useIsTouch(): boolean {
    return useMediaQuery("(hover: none)");
}
