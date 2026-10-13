import type { ReactNode } from "react";

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

export const SplitIcon = () => <Icon><rect x="2.5" y="6" width="5" height="12" rx="1" /><rect x="9.5" y="6" width="5" height="12" rx="1" /><rect x="16.5" y="6" width="5" height="12" rx="1" /></Icon>;
export const OverviewIcon = () => <Icon><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Icon>;
export const MapIcon = () => <Icon><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z" /><path d="M9 4v13.5M15 6.5V20" /></Icon>;
export const ActivityIcon = () => <Icon><path d="M3 12h4l3-8 4 16 3-8h4" /></Icon>;
export const TimelineIcon = () => <Icon><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M11 5h9M11 19h9M11 12h6" /></Icon>;
export const ImportIcon = () => <Icon><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></Icon>;
export const SettingsIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Icon>;
export const SidebarIcon = () => <Icon size={16}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>;
export const CrosshairIcon = () => <Icon size={16}><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></Icon>;
export const PlayIcon = () => <Icon size={14}><path d="M7 5v14l11-7z" fill="currentColor" /></Icon>;
export const StopIcon = () => <Icon size={14}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /></Icon>;
export const PlusIcon = () => <Icon size={16}><path d="M12 5v14M5 12h14" /></Icon>;
export const LayersIcon = () => <Icon size={16}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></Icon>;
export const MinusIcon = () => <Icon size={16}><path d="M5 12h14" /></Icon>;

export const WindowMinimize = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" /></svg>;
export const WindowMaximize = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>;
export const WindowClose = () => <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0 0 10" stroke="currentColor" /></svg>;
export const PinIcon = () => <Icon size={16}><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" /><circle cx="12" cy="10" r="2.2" /></Icon>;
export const CaretIcon = () => <Icon size={12}><path d="m6 9 6 6 6-6" /></Icon>;
export const ResetIcon = () => <Icon size={15}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>;
export const TerrainIcon = () => <Icon size={16}><path d="m2.5 19 6-9 4 5.5 2.5-3.5 6.5 7z" /><circle cx="16.5" cy="6.5" r="2" /></Icon>;
export const ExpandIcon = () => <Icon size={14}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></Icon>;
export const LinkIcon = () => <Icon><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Icon>;
export const CloseIcon = () => <Icon size={14}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const CheckIcon = () => <Icon size={14}><path d="m5 12 5 5 9-10" /></Icon>;
