const Icon = ({ children }) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const ClockIcon = () => (
  <Icon><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Icon>
);
export const BellIcon = () => (
  <Icon><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></Icon>
);
export const LoginIcon = () => (
  <Icon><path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" /><path d="M10 16.5 14.5 12 10 7.5" /><path d="M14.5 12H4" /></Icon>
);
export const GlobeIcon = () => (
  <Icon><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z" /></Icon>
);
export const DownloadIcon = () => (
  <Icon><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></Icon>
);
export const PowerIcon = () => (
  <Icon><path d="M12 3.5v8" /><path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0" /></Icon>
);
export const AlertIcon = () => (
  <Icon><path d="M12 3.8 21 19.5H3z" /><path d="M12 10v4.2" /><path d="M12 17h.01" /></Icon>
);
export const CloseIcon = () => (
  <Icon><path d="M7 7l10 10M17 7 7 17" /></Icon>
);
export const NotesIcon = () => (
  <Icon><path d="M7 3.5h7.5L19 8v12.5H7z" /><path d="M14.5 3.5V8H19" /><path d="M10 12h6M10 15.5h6" /></Icon>
);
export const MenuBarIcon = () => (
  <Icon><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="M3.5 9h17" /><path d="M13 7h5" /></Icon>
);
export const LockIcon = () => (
  <Icon><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></Icon>
);
export const KeyIcon = () => (
  <Icon><circle cx="8" cy="15" r="3.5" /><path d="m10.5 12.5 8-8" /><path d="m15.5 7.5 2.5 2.5" /><path d="m17.5 5.5 2 2" /></Icon>
);
export const ChartIcon = () => (
  <Icon><path d="M4.5 19.5h15" /><path d="M7.5 16v-4" /><path d="M12 16V8" /><path d="M16.5 16v-6" /></Icon>
);
