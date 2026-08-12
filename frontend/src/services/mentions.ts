import type { ServerMember } from "../types/chat.ts";

const MAX_RESULTS = 8;

export type MentionMatch = {
    triggerIndex: number;
    query: string;
};

/** Detects an in-progress "@query" mention ending at the caret, or null if none. */
export function detectMentionQuery(text: string, caretIndex: number): MentionMatch | null {
    const uptoCaret = text.slice(0, caretIndex);
    const at = uptoCaret.lastIndexOf("@");
    if (at === -1) return null;

    const before = at > 0 ? uptoCaret[at - 1] : undefined;
    if (before !== undefined && !/\s/.test(before)) return null;

    const query = uptoCaret.slice(at + 1);
    if (/\s/.test(query)) return null;

    return { triggerIndex: at, query };
}

export function memberDisplayName(member: ServerMember): string {
    const nickname = member.nickname?.trim();
    if (nickname) return nickname;
    const fullName = `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim();
    return fullName || `User ${member.user_id}`;
}

export type MentionResults = {
    showEveryone: boolean;
    members: ServerMember[];
    total: number;
};

export function computeMentionResults(allMembers: ServerMember[], query: string): MentionResults {
    const normalized = query.trim().toLowerCase();
    const showEveryone = "everyone".startsWith(normalized);

    const filtered = normalized
        ? allMembers.filter((member) => {
            const nickname = member.nickname?.toLowerCase() ?? "";
            const fullName = `${member.first_name ?? ""} ${member.last_name ?? ""}`.toLowerCase();
            return nickname.includes(normalized) || fullName.includes(normalized);
        })
        : allMembers;

    const members = filtered.slice(0, MAX_RESULTS);
    return { showEveryone, members, total: members.length + (showEveryone ? 1 : 0) };
}
