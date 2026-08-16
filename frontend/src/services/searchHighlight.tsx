import { Fragment } from "react";
import type React from "react";

const HL_PATTERN = /\[\[HL]]([\s\S]*?)\[\[\/HL]]/g;

/**
 * Splits a ts_headline string on its [[HL]]...[[/HL]] markers and renders the
 * matched spans as <mark>. Those markers are Postgres's own placeholder
 * syntax wrapped around plain message text, not HTML — this must be the only
 * way headline text ever reaches the DOM, never dangerouslySetInnerHTML.
 */
export function renderHeadline(headline: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    HL_PATTERN.lastIndex = 0;
    while ((match = HL_PATTERN.exec(headline)) !== null) {
        if (match.index > lastIndex) {
            parts.push(<Fragment key={key++}>{headline.slice(lastIndex, match.index)}</Fragment>);
        }
        parts.push(<mark key={key++}>{match[1]}</mark>);
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < headline.length) {
        parts.push(<Fragment key={key++}>{headline.slice(lastIndex)}</Fragment>);
    }

    return parts;
}
