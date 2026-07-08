import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#07090d",
        panel: "#0e1218",
        panel2: "#151b24",
        panel3: "#1b222d",
        line: "#1f2733",
        ink: "#e8eef5",
        muted: "#8b98a5",
        faint: "#59636f",
        up: "#2ebd85",
        down: "#f6465d",
        accent: "#4f8ef7",
        accent2: "#8b5cf6",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 20px rgba(79, 142, 247, 0.35)",
        "glow-up": "0 0 16px rgba(46, 189, 133, 0.35)",
        "glow-down": "0 0 16px rgba(246, 70, 93, 0.35)",
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.35)",
      },
      backgroundImage: {
        "brand-grad": "linear-gradient(135deg, #4f8ef7 0%, #8b5cf6 100%)",
        "up-grad": "linear-gradient(135deg, #2ebd85 0%, #1e9e6f 100%)",
        "down-grad": "linear-gradient(135deg, #f6465d 0%, #d63750 100%)",
      },
    },
  },
  plugins: [],
};
export default config;
