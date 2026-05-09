/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Theme tokens used by the existing Wave H components and screens.
        // Dark POS-friendly palette — high contrast, easy on the eyes
        // under fluorescent depot lighting.
        'bg-deep':     '#0b0f14',
        'bg-surface':  '#141b22',
        'bg-elevated': '#1e2832',
        'border':      '#2a3640',
        'text-primary':   '#e6edf3',
        'text-secondary': '#9aa7b3',
        'text-tertiary':  '#6a7783',
        'accent':  '#4fc3f7',
        'success': '#4ade80',
        'warning': '#fbbf24',
        'danger':  '#f87171',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
