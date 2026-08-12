import type { ServerMember } from "../types/chat.ts";
import { memberDisplayName, type MentionResults } from "../services/mentions.ts";

function memberInitials(member: ServerMember): string {
    return memberDisplayName(member).slice(0, 2).toUpperCase();
}

type Props = {
    results: MentionResults;
    activeIndex: number;
    onSelectMember: (member: ServerMember) => void;
    onSelectEveryone: () => void;
};

export default function MentionAutocomplete({ results, activeIndex, onSelectMember, onSelectEveryone }: Props) {
    if (results.total === 0) return null;

    return (
        <ul className="mention-autocomplete" role="listbox">
            {results.showEveryone ? (
                <li
                    className={`mention-autocomplete-item ${activeIndex === 0 ? "active" : ""}`}
                    role="option"
                    aria-selected={activeIndex === 0}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onSelectEveryone();
                    }}
                >
                    <span className="mention-autocomplete-avatar mention-autocomplete-avatar-everyone" aria-hidden="true">@</span>
                    <span className="mention-autocomplete-name">everyone</span>
                    <span className="mention-autocomplete-hint">Notify everyone (owner only)</span>
                </li>
            ) : null}
            {results.members.map((member, index) => {
                const itemIndex = (results.showEveryone ? 1 : 0) + index;
                return (
                    <li
                        key={member.user_id}
                        className={`mention-autocomplete-item ${activeIndex === itemIndex ? "active" : ""}`}
                        role="option"
                        aria-selected={activeIndex === itemIndex}
                        onMouseDown={(e) => {
                            e.preventDefault();
                            onSelectMember(member);
                        }}
                    >
                        {member.avatar_url ? (
                            <img className="mention-autocomplete-avatar" src={member.avatar_url} alt="" />
                        ) : (
                            <span className="mention-autocomplete-avatar mention-autocomplete-avatar-fallback" aria-hidden="true">
                                {memberInitials(member)}
                            </span>
                        )}
                        <span className="mention-autocomplete-name">{memberDisplayName(member)}</span>
                    </li>
                );
            })}
        </ul>
    );
}
