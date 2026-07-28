type RorkEditorOptions = { shotFile?: string };

interface Window {
  __rork?: { refreshShots: () => Promise<void> };
  __rorkEditor?: { open: (options?: RorkEditorOptions) => Promise<void> };
}
