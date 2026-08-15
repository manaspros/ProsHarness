import type { Config } from "tailwindcss";

// ProsHarness dashboard design system foundation (Stage 1).
//
// Colour tokens are wired through CSS custom properties defined in
// app/globals.css (the shadcn/ui convention: --background, --foreground,
// --card, --border, --ring, etc). This file just maps those properties into
// Tailwind's theme so `bg-background`, `text-foreground`, `border-border`,
// etc. work everywhere, and defines the type scale + prose-plan utility
// used for rendering long-form plan markdown.
const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Elevation ramp used by the Surface/Panel primitive, on top of the
        // shadcn semantic tokens above.
        surface: {
          ground: "hsl(var(--surface-ground))",
          base: "hsl(var(--surface-base))",
          raised: "hsl(var(--surface-raised))",
          overlay: "hsl(var(--surface-overlay))",
        },
        // Status colours used by StatusPill, drawn from the theme accent
        // family rather than stock red/green/yellow.
        status: {
          parked: "hsl(var(--status-parked))",
          running: "hsl(var(--status-running))",
          done: "hsl(var(--status-done))",
          idle: "hsl(var(--status-idle))",
          pass: "hsl(var(--status-pass))",
          fail: "hsl(var(--status-fail))",
          blocked: "hsl(var(--status-blocked))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.4" }],
        sm: ["0.8125rem", { lineHeight: "1.5" }],
        base: ["0.9375rem", { lineHeight: "1.6" }],
        lg: ["1.0625rem", { lineHeight: "1.6" }],
        xl: ["1.25rem", { lineHeight: "1.5" }],
        "2xl": ["1.5625rem", { lineHeight: "1.4" }],
        "3xl": ["1.953rem", { lineHeight: "1.3" }],
      },
      boxShadow: {
        "panel-raised":
          "0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.65)",
        "panel-overlay":
          "0 1px 0 rgba(255,255,255,0.06) inset, 0 16px 48px -12px rgba(0,0,0,0.75)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
