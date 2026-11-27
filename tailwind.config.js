/** @type {import('tailwindcss').Config} */
export default {
  content: ['./popup.html', './options.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Source Serif 4"', 'Georgia', '"Noto Serif SC"', '"Songti SC"', 'serif'],
        sans: ['Inter', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
      },
      colors: {
        ink: { 50: '#f7f7f5', 100: '#eeede9', 200: '#dcdad3', 400: '#9a968a', 600: '#5c594f', 800: '#2c2a25', 900: '#1a1916' },
        accent: { 500: '#8b2c2c', 600: '#742424', 50: '#fbf1f1' },
      },
    },
  },
  plugins: [],
};
