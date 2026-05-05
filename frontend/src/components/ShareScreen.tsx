import { ScreenShare, ScreenShareOff } from "lucide-react";

type ShareScreenProps = {
    onClick: () => void;
    isActive: boolean;
}

export const ShareScreen = ({ onClick, isActive }: ShareScreenProps) => {
    return (
        <button
            className="micam-btn"
            type="button"
            aria-label={isActive ? "Stop screen share" : "Share screen"}
            title={isActive ? "Stop screen share" : "Share screen"}
            onClick={onClick}
        >
            {isActive ? <ScreenShareOff size={20} color="#B80606" /> : <ScreenShare size={20} />}
        </button>
    );
};