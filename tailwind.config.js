/**
 * Tailwind 本地构建配置（可选）
 * ---------------------------------------------------------------------
 * 只有执行 `npm run build:css` 时才会用到。
 * 日常开发与「零构建」部署模式完全不需要这个文件。
 *
 * 配置内容必须与 index.html / admin.html 里内联的 tailwind.config 保持一致，
 * 否则本地构建出来的样式会与 CDN 模式不一致。
 */
module.exports = {
  darkMode: 'class',
  // 扫描范围刻意收窄，只扫页面与脚本，构建更快、产物更小
  content: ['./public/**/*.html', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        elev: 'rgb(var(--c-elev) / <alpha-value>)',
        fg: 'rgb(var(--c-fg) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        accent2: 'rgb(var(--c-accent2) / <alpha-value>)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { card: '20px' },
      maxWidth: { shell: '1180px' },
    },
  },
  plugins: [],
};
