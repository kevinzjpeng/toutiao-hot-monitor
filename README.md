# 🔥 头条热点监测工具

今日头条热点实时监测工具，每 10 分钟自动抓取更新，保存 7 天历史数据。

## 📁 项目结构

```
toutiao-hot-monitor/
├── src/
│   ├── server.js      # Web 服务器 + API
│   ├── scraper.js     # 数据抓取模块
│   ├── storage.js     # 数据存储 (JSON)
│   └── public/
│       └── index.html # 前端页面
├── data/
│   └── hotspots.json  # 热点数据库
├── config.json        # 配置文件
└── package.json
```

## 🚀 快速开始

### 安装依赖
```bash
cd toutiao-hot-monitor
npm install
```

### 初始化数据库
```bash
npm run init
```

### 启动服务
```bash
npm start
```

访问 http://localhost:3000 查看热点榜单

## ⚙️ 配置说明

编辑 `config.json`:

```json
{
  "scrapeInterval": "*/10 * * * *",  // cron 表达式，默认每 10 分钟
  "dataRetentionDays": 7,             // 数据保留天数
  "port": 3000,                       // Web 服务端口
  "toutiaoUrl": "https://www.toutiao.com/"
}
```

**注意**: `https://www.toutiao.com/hot/` 已废弃（返回 404），程序使用首页 `https://www.toutiao.com/` 抓取热榜数据。

## 📡 API 接口

### 热点数据

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/hotspots` | GET | 获取最新热点榜单 |
| `/api/hotspots/refresh` | POST | 手动刷新热点（使用 browser） |
| `/api/snapshots` | GET | 获取历史快照列表 |
| `/api/snapshots/:time` | GET | 获取特定时间点数据 |
| `/api/topic/:topic` | GET | 获取话题历史趋势 |
| `/api/scrape` | POST | 手动触发抓取 |
| `/api/cleanup` | POST | 清理旧数据 |

### 分类与排行

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/categories` | GET | 获取分类统计 |
| `/api/new` | GET | 获取新上榜热点 |
| `/api/rising` | GET | 获取上升最快热点 |
| `/api/rising-fast` | GET | 获取上升最快的文章（browser） |

### 科技/生活

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/tech-life` | GET | 获取科技/生活类文章（browser） |

### 用户

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/user` | GET | 获取用户信息 |
| `/api/user/articles` | GET | 获取用户文章列表 |
| `/api/user/articles/refresh` | POST | 刷新用户文章 |
| `/api/mp/collect/batch` | POST | 按配置转发 mp.toutiao.com collect/batch 请求 |
| `/api/mp/article/draft` | POST | 使用 agent-browser 自动填写并保存草稿 |
| `/api/mp/article/draft/selenium` | POST | 使用 Selenium + Chrome 自动填写并保存草稿 |
| `/api/mp/article/publish/http` | POST | 直接回放浏览器 publish 请求保存草稿 |

## 🔧 常用命令

```bash
# 手动抓取一次
npm run scrape

# 查看实时日志
tail -f data/hotspots.json

# 后台运行
nohup npm start &

# 停止服务
pkill -f "node src/server.js"
```

## 📊 功能特性

- ✅ 每 10 分钟自动抓取头条热搜
- ✅ 实时网页展示（带趋势图表）
- ✅ 保存 7 天历史数据
- ✅ 自动清理过期数据
- ✅ RESTful API 接口
- ✅ 响应式前端设计
- ✅ 🆕 自动新闻分类（政治、财经、科技、体育、娱乐、社会、国际、健康、其他）
- ✅ 🆕 用户信息显示（头像、粉丝、关注、获赞）
- ✅ 🆕 **头条后台访问** - 通过管理后台获取用户文章列表
- ✅ 🆕 **Browser 自动化** - 使用 agent-browser 获取实时热点和科技/生活文章

## ⚠️ 注意事项

1. 使用 `agent-browser` 进行浏览器自动化抓取真实数据
2. 已配置 Cookie 用于绕过反爬和登录验证
3. 生产环境建议使用反向代理（nginx）和进程管理（pm2）
4. 如需更多热榜数据，可调整抓取逻辑

### Cookie 配置

如果抓取失败或数据不完整，可更新 `config.json` 中的 Cookie：

```json
{
  "cookies": {
    "tt_webid": "你的 tt_webid",
    "sessionid": "你的 sessionid",
    "sid_tt": "你的 sid_tt"
  }
}
```

获取 Cookie 方法：
1. 浏览器访问 https://www.toutiao.com/
2. 按 F12 打开开发者工具
3. 复制 Request Headers 中的 Cookie

## ✅ 已实现

- [x] 集成 agent-browser 进行真实数据抓取
- [x] 每 10 分钟自动刷新
- [x] 保存 7 天历史数据

## 🌐 访问 mp.toutiao.com（Cookie + Header）

项目已新增接口：`POST /api/mp/collect/batch`。

### 1) 创建本地配置（推荐）

新建 `mp-request.local.json`（已加入 `.gitignore`，不会提交到仓库）：

```json
{
  "mode": "agent-browser",
  "fallbackToHttp": true,
  "url": "https://mp.toutiao.com/monitor_browser/collect/batch/?biz_id=toutiao_mp",
  "rawHeaders": ":authority\nmp.toutiao.com\n:method\nPOST\n:path\n/monitor_browser/collect/batch/?biz_id=toutiao_mp\n:scheme\nhttps\naccept\n*/*\ncontent-type\napplication/json\norigin\nhttps://mp.toutiao.com\nreferer\nhttps://mp.toutiao.com/profile_v4/index\nx-secsdk-csrf-token\n你的token",
  "rawCookie": "你的完整cookie字符串",
  "body": {
    "events": []
  },
  "timeoutMs": 30000
}
```

### 2) 调用接口

```bash
curl -X POST http://localhost:3000/api/mp/collect/batch \
  -H "Content-Type: application/json" \
  -d '{}'
```

也可以在请求体里覆盖本次参数（优先级最高），例如：

```json
{
  "rawCookie": "本次临时cookie",
  "body": { "events": [{"type":"ping"}] }
}
```

说明：
1. 支持 DevTools 两种 Header 粘贴格式：`header: value` 或「键值分两行」。
2. 会自动过滤 HTTP/2 伪头（`:authority/:method/:path/:scheme`）与 `content-length`。
3. 默认使用 `agent-browser` 模式（更贴近浏览器环境），若不可用会按 `fallbackToHttp` 自动回退到 HTTP 请求。
4. 建议定期更新 Cookie 和 `x-secsdk-csrf-token`，过期后会返回未登录或鉴权失败。

## ✍️ 保存草稿到头条

接口：`POST /api/mp/article/draft`

请求示例：

```bash
curl -X POST http://localhost:3000/api/mp/article/draft \
  -H "Content-Type: application/json" \
  -d '{
    "title": "测试草稿标题",
    "content": "这是自动化保存的草稿正文。",
    "rawCookie": "你的完整cookie",
    "rawHeaders": "referer\nhttps://mp.toutiao.com/profile_v4/index"
  }'
```

说明：
1. 会打开头条创作页，自动填入标题和正文，并尝试点击“保存草稿”。
2. 默认打开地址为 `https://mp.toutiao.com/profile_v4/graphic/publish`，可通过 `openUrl` 覆盖。
3. 如页面结构变更导致按钮识别失败，可先手动打开页面确认按钮文案后再调整选择器。

### Selenium 版本

接口：`POST /api/mp/article/draft/selenium`

```bash
curl -X POST http://localhost:3000/api/mp/article/draft/selenium \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Selenium 草稿标题",
    "content": "Selenium 自动化正文内容",
    "rawCookie": "你的完整cookie",
    "headless": true,
    "openUrl": "https://mp.toutiao.com/profile_v4/graphic/publish"
  }'
```

说明：
1. 依赖本机可用 Chrome/Chromium，可通过环境变量 `CHROME_BIN` 指定二进制路径。
2. 返回结果含 `visibleHints`，用于诊断当前页面是否命中编辑器/草稿按钮。

### 直接回放 publish 请求（推荐用于桌面抓包）

接口：`POST /api/mp/article/publish/http`

用途：
1. 当自动化浏览器会触发 `保存失败`（例如 code=7050）时，可使用你在桌面 Chrome 成功请求中复制的 headers/cookie/path 直接回放。
2. 支持两种方式提供请求体：
   - `rawBody`：直接粘贴抓包中的 form-urlencoded body（最稳妥）
   - `title + content`：服务端自动构造基础表单

示例：

```bash
curl -X POST http://localhost:3000/api/mp/article/publish/http \
  -H "Content-Type: application/json" \
  -d '{
    "rawHeaders": ":authority\nmp.toutiao.com\n:method\nPOST\n:path\n/mp/agw/article/publish?source=mp&type=article&aid=1231\n:scheme\nhttps\ncontent-type\napplication/x-www-form-urlencoded;charset=UTF-8\norigin\nhttps://mp.toutiao.com\nreferer\nhttps://mp.toutiao.com/profile_v4/graphic/publish\nx-secsdk-csrf-token\n你的token\ntt-anti-token\n你的anti-token",
    "rawCookie": "你的完整cookie",
    "rawBody": "source=29&extra=...&content=...&title=..."
  }'
```

说明：
1. 如果你已经从桌面 Chrome 抓到完整请求，优先使用 `rawBody`，成功率最高。
2. `:path` 中的 `msToken`、`a_bogus` 可能会过期，建议每次取最新值。

## 📝 待优化

- [ ] 添加微信/Telegram 推送通知
- [ ] 支持多平台监测（微博、知乎等）
- [ ] 热点趋势预测分析
- [ ] 提取热度值和趋势箭头
