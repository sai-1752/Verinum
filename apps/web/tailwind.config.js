/** Colours are CSS variables (src/styles.css) so light/dark and chart palettes share one source. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["variant", [":root:not([data-theme='light']) &", ":root[data-theme='dark'] &"]],
  theme: {
    extend: {
      colors: {
        paper: v("paper"), panel: v("panel"), sunk: v("sunk"), ink: v("ink"), "ink-2": v("ink-2"), "ink-3": v("ink-3"),
        line: v("line"), "line-2": v("line-2"), thread: v("thread"), "thread-ink": v("thread-ink"), "thread-wash": v("thread-wash"),
        marker: v("marker"), up: v("up"), down: v("down"), warn: v("warn"), "warn-wash": v("warn-wash"), "down-wash": v("down-wash"), "up-wash": v("up-wash"),
      },
      fontFamily: {
        sans: ['"Schibsted Grotesk Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ['"Newsreader Variable"', "ui-serif", "Georgia", "serif"],
      },
      borderRadius: { DEFAULT: "4px", md: "6px", lg: "10px" },
      fontSize: { xs: ["12px", "16px"], sm: ["13.5px", "20px"], base: ["15px", "24px"] },
      maxWidth: { prose: "68ch" },
    },
  },
  plugins: [],
};
