/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0F1115',
          panel: '#181B20',
          card: '#1F242D',
          border: '#2D3340'
        }
      }
    },
  },
  plugins: [],
}
