import type { Channel } from "../types/chat";

type Props = {
  channels: Channel[];
  selectedChannelId: number;
  onSelect: (channelId: number) => void;
  onAddChannel: () => void;
};

export default function ChannelList({ channels, selectedChannelId, onSelect, onAddChannel }: Props) {
  return (
    <aside className="channel-sidebar">
      <div className="channel-divider" />
      <button className="channel-add-btn" onClick={onAddChannel} aria-label="Добавить канал" title="Добавить канал">
        +
      </button>
      <ul className="channel-list">
        {channels.map((ch) => (
          <li key={ch.id}>
            <button
              className={`channel-dot ${selectedChannelId === ch.id ? "active" : ""}`}
              onClick={() => onSelect(ch.id)}
              title={`Канал ${ch.name}`}
              aria-label={`Канал ${ch.name}`}
            >
              {ch.name}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}