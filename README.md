# ScholarClip AI

一键提取学术网页（arXiv / Google Scholar / IEEE Xplore / ACM DL / 普通学术文章）→ LLM 结构化总结 + APA 7th / IEEE 引用 → 写入 Notion 数据库。

## 安装

```bash
npm install
npm run build        # 产物在 dist/
```

Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/` 目录。
首次安装会自动打开设置页。开发时可用 `npm run dev`（watch 模式），改动后在扩展页点刷新。

## 配置

1. **LLM**：Base URL（OpenAI 兼容，如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`）、API Key、模型名、输出语言。
   保存时插件会按需申请该域名的访问权限（`optional_host_permissions`）。
2. **Notion**：在 <https://www.notion.so/my-integrations> 创建 Integration，复制 Token；
   在目标数据库右上角「··· → 连接」添加该 Integration；把数据库链接粘贴到 Database ID。
3. 点击「测试连接并校验数据库字段」。

推荐数据库属性（名称不区分大小写，也支持中文别名）：

| 属性 | 类型 | 中文别名 |
|---|---|---|
| Title | 标题（任意名称） | 标题 |
| Authors | 文本 / 多选 | 作者 |
| Year | 数字（也可文本/单选/日期） | 年份 |
| URL | 网址 / 文本 | 链接 |
| Tags | 多选 / 文本 | 标签 |
| Citation | 文本 | 引用 |
| Venue（可选） | 文本 / 单选 | 期刊、会议 |
| DOI（可选） | 文本 / 网址 | — |

缺失或类型不符的字段会被跳过，不影响保存。页面正文包含：💡 一句话结论、研究问题、研究方法、核心发现（列表）、局限性、引用、原文链接。

## 结构

```
public/manifest.json        MV3 清单：activeTab / scripting / storage + api.notion.com
popup.html, options.html    页面入口
src/background/index.ts     Service Worker：代理 LLM / Notion 请求，读取密钥
src/popup/App.tsx           弹窗：状态栏、AI 提取、可编辑预览、保存到 Notion
src/options/Options.tsx     设置页 + 连接测试 / 字段校验
src/lib/extract.ts          页面提取：Readability + citation_* / dc.* meta + arXiv/Scholar/IEEE/ACM 专用提取
src/lib/prompt.ts           LLM Prompt 模板（逐字来自 gemini-code-1795775626902.md）
src/lib/llm.ts              OpenAI 兼容调用、JSON 严格解析/修复/重试、字段规范化
src/lib/notion.ts           数据库字段校验、Properties 自适应映射、Page Body 构建
src/lib/storage.ts          chrome.storage.local（配置）/ storage.session（草稿）
```

## 说明

- 暂不支持直接解析 PDF 页面；arXiv PDF 会提示跳转到 abs 页。
- 页面上选中 ≥200 字的文本时，优先使用选中内容作为正文。
- AI 结果保存在会话草稿中，等待期间关闭弹窗不会丢失，编辑内容也会自动保存。
- 未包含图标，Chrome 会显示默认字母图标；可在 `public/` 放 PNG 并在 manifest 中添加 `icons`。
