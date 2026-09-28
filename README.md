# 三测点逐期判读

京广线株洲南、衡阳北、韶关南三个测点 2023—2024 年 Sentinel-2 影像的逐期判读网站：项目背景、学习（含图鉴）、判读工作台、实时看板、组长台。

- 网页：纯静态 HTML/CSS/JS，由 GitHub Pages 发布，无需构建。
- 记录：存入 Supabase（`assets/js/config.js` 中的公开密钥只能读取和新增，建表与权限见项目工作目录中的 `supabase_schema.sql`）。
- 数据：`data/` 为各站期次、观察范围、铁路线和图鉴说明；`img/` 为统一拉伸的显示图（真彩色、植被假彩色）。
- 影像来源：欧洲航天局 Copernicus Sentinel-2 L2A。
