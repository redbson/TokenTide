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
export const PowerIcon = () => (
  <Icon><path d="M12 3.5v8" /><path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0" /></Icon>
);
export const AlertIcon = () => (
  <Icon><path d="M12 3.8 21 19.5H3z" /><path d="M12 10v4.2" /><path d="M12 17h.01" /></Icon>
);
export const CloseIcon = () => (
  <Icon><path d="M7 7l10 10M17 7 7 17" /></Icon>
);
