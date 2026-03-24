const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
const storage = require('./storage');
const { scrapeHotSearches } = require('./scraper');
const config = require('../config.json');

const app = express();
const PORT = Number(process.env.PORT) || config.port || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CONFIG_PATH = path.join(__dirname, '../config.json');
const COOKIES_PATH = path.join(__dirname, '../cookies.json');

function formatLocalDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseRawCookie(rawCookie) {
  return String(rawCookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) return acc;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (key) {
        acc[key] = value;
      }
      return acc;
    }, {});
}

function buildRawCookie(cookieMap) {
  return Object.entries(cookieMap || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${key}=${String(value).trim()}`)
    .join('; ');
}

function buildCookieFileEntries(cookieMap) {
  return Object.entries(cookieMap || {}).map(([name, value]) => ({
    name,
    value: String(value),
    domain: '.toutiao.com',
    path: '/'
  }));
}

function writeJsonFile(filePath, content) {
  fs.writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

function getCookieSettings() {
  const cookieMap = config.cookies || {};
  const rawCookie = buildRawCookie(cookieMap);
  return {
    cookies: cookieMap,
    rawCookie,
    updatedAt: formatLocalDateTime()
  };
}

function saveCookieSettings(rawCookie) {
  const cookieMap = parseRawCookie(rawCookie);
  if (Object.keys(cookieMap).length === 0) {
    throw new Error('Cookie 不能为空或格式无效');
  }

  const nextConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  nextConfig.cookies = cookieMap;
  nextConfig.mpRequest = nextConfig.mpRequest || {};
  nextConfig.mpRequest.rawCookie = buildRawCookie(cookieMap);
  writeJsonFile(CONFIG_PATH, nextConfig);
  writeJsonFile(COOKIES_PATH, { cookies: buildCookieFileEntries(cookieMap) });

  config.cookies = cookieMap;
  config.mpRequest = config.mpRequest || {};
  config.mpRequest.rawCookie = nextConfig.mpRequest.rawCookie;

  return getCookieSettings();
}

function ensureAuthenticated(req, res) {
  if (req.session && req.session.user) {
    return true;
  }
  res.status(401).json({ success: false, message: 'Unauthorized' });
  return false;
}

app.use(cors());
app.use(express.json());

app.use(session({
  secret: 'toutiao-hot-monitor-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS
}));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // Hardcoded for demo, you can change these credentials or use config.json
  if (username === 'pengtianyu' && password === 'sunny808') {
    req.session.user = username;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/cookies', (req, res) => {
  try {
    if (!ensureAuthenticated(req, res)) return;
    res.json({ success: true, data: getCookieSettings() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/admin/cookies', async (req, res) => {
  try {
    if (!ensureAuthenticated(req, res)) return;
    const saved = saveCookieSettings(req.body?.rawCookie);

    let userInfo = null;
    let userInfoRefreshMessage = '用户信息刷新失败，请检查 Cookie 是否有效';
    try {
      const { fetchUserInfo } = require('./scraper');
      userInfo = await fetchUserInfo();
      if (userInfo) {
        userInfoRefreshMessage = '用户信息已自动刷新';
      }
    } catch (refreshError) {
      console.error('⚠️ Cookie 保存后刷新用户信息失败:', refreshError.message);
    }

    res.json({
      success: true,
      data: {
        ...saved,
        userInfo
      },
      message: `Cookie 已保存，${userInfoRefreshMessage}`
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Authentication Middleware
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/api/login') {
    return next();
  }
  if (!req.session || !req.session.user) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// API: 获取最新热点榜单
app.get('/api/hotspots', (req, res) => {
  try {
    const latestTime = storage.getLatestSnapshot();
    if (!latestTime) {
      return res.json({ success: false, message: '暂无数据' });
    }
    
    const hotspots = storage.getHotSearchesBySnapshot(latestTime);
    res.json({
      success: true,
      data: hotspots,
      snapshotTime: latestTime
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取历史快照列表
app.get('/api/snapshots', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const snapshots = storage.getRecentSnapshots(limit);
    res.json({ success: true, data: snapshots });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取特定时间点的数据
app.get('/api/snapshots/:time', (req, res) => {
  try {
    const hotspots = storage.getHotSearchesBySnapshot(req.params.time);
    res.json({ success: true, data: hotspots });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取话题历史趋势
app.get('/api/topic/:topic', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const history = storage.getTopicHistory(decodeURIComponent(req.params.topic), days);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 手动触发抓取
app.post('/api/scrape', async (req, res) => {
  try {
    console.log('🔄 手动触发热点抓取...');
    const result = await scrapeHotSearches();
    res.json({ success: true, count: result.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取上升最快的热点
app.get('/api/rising', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const newOnly = req.query.new === 'true';
    const rising = storage.getFastestRising(limit, newOnly);
    const latestTime = storage.getLatestSnapshot();
    res.json({ success: true, data: rising, snapshotTime: latestTime });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取新上榜热点
app.get('/api/new', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    let rising = storage.getNewEntries(limit);
    
    // 按分类过滤
    if (category) {
      rising = rising.filter(item => item.category === category);
    }
    
    const latestTime = storage.getLatestSnapshot();
    res.json({ success: true, data: rising, snapshotTime: latestTime });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取分类列表
app.get('/api/categories', (req, res) => {
  try {
    const rising = storage.getNewEntries(100);
    const categoryCount = {};
    
    rising.forEach(item => {
      categoryCount[item.category] = (categoryCount[item.category] || 0) + 1;
    });
    
    const categories = Object.entries(categoryCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取科技/生活文章
app.get('/api/tech-life', async (req, res) => {
  try {
    const { fetchTechLifeArticles } = require('./browser-scraper');
    console.log('📱 获取科技/生活文章...');
    const articles = await fetchTechLifeArticles();
    res.json({ success: true, data: articles, count: articles.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取上升最快的文章
app.get('/api/rising-fast', async (req, res) => {
  try {
    const { getFastestRisingArticles } = require('./browser-scraper');
    console.log('📈 获取上升最快的文章...');
    const articles = await getFastestRisingArticles();
    res.json({ success: true, data: articles, count: articles.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 手动刷新热点
app.post('/api/hotspots/refresh', async (req, res) => {
  try {
    const { scrapeHotSearches } = require('./scraper');
    console.log('🔄 手动刷新热点...');
    const hotspots = await scrapeHotSearches();
    res.json({ success: true, data: hotspots, count: hotspots.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取用户信息
app.get('/api/user', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const userInfoPath = path.join(__dirname, '../data/user-info.json');
    
    if (fs.existsSync(userInfoPath)) {
      const userInfo = JSON.parse(fs.readFileSync(userInfoPath, 'utf8'));
      res.json({ success: true, data: userInfo });
    } else {
      res.json({ success: false, message: '暂无用户信息，请先抓取' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 手动获取用户信息
app.post('/api/user/fetch', async (req, res) => {
  try {
    const { fetchUserInfo } = require('./scraper');
    console.log('🔄 手动触发用户信息获取...');
    const userInfo = await fetchUserInfo();
    
    if (userInfo) {
      res.json({ success: true, data: userInfo });
    } else {
      res.json({ success: false, message: '获取失败，请检查登录状态' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 获取用户文章列表
app.get('/api/user/articles', async (req, res) => {
  try {
    const { getUserArticles } = require('./user-articles');
    
    console.log('📝 获取用户文章...');
    const articles = await getUserArticles();
    
    res.json({ success: true, data: articles, count: articles.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 手动刷新用户文章
app.post('/api/user/articles/refresh', async (req, res) => {
  try {
    const { getUserArticles } = require('./user-articles');
    console.log('🔄 手动刷新用户文章...');
    const articles = await getUserArticles();
    res.json({ success: true, data: articles, count: articles.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 触发 mp.toutiao.com monitor collect/batch 请求
app.post('/api/mp/collect/batch', async (req, res) => {
  try {
    const { sendMpCollectBatch } = require('./mp-client');
    console.log('🌐 发送 mp.toutiao.com collect/batch 请求...');

    const result = await sendMpCollectBatch(req.body || {});

    res.status(result.ok ? 200 : 502).json({
      success: result.ok,
      status: result.status,
      statusText: result.statusText,
      url: result.url,
      data: result.data
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 使用 agent-browser 保存图文草稿
app.post('/api/mp/article/draft', async (req, res) => {
  try {
    const { saveDraftArticleViaAgentBrowser } = require('./mp-client');
    console.log('📝 正在保存头条草稿...');

    const result = await saveDraftArticleViaAgentBrowser(req.body || {});

    res.status(result.success ? 200 : 502).json({
      success: result.success,
      mode: result.mode,
      openUrl: result.openUrl,
      title: result.title,
      result: result.result
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 使用 Selenium + Chrome 保存图文草稿
app.post('/api/mp/article/draft/selenium', async (req, res) => {
  try {
    const { saveDraftArticleViaSelenium } = require('./selenium-draft');
    console.log('🤖 正在使用 Selenium 保存头条草稿...');

    const result = await saveDraftArticleViaSelenium(req.body || {});

    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 使用 Selenium + Chrome 按 AIMedia 流程执行发布按钮
app.post('/api/mp/article/publish/selenium', async (req, res) => {
  try {
    const { saveDraftArticleViaSelenium } = require('./selenium-draft');
    console.log('🚀 正在使用 Selenium 发布头条图文...');

    const result = await saveDraftArticleViaSelenium({
      ...(req.body || {}),
      publish: true,
      autoSaveOnly: false
    });

    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 使用 Selenium 先保存草稿再从草稿列表回编发布
app.post('/api/mp/article/publish/selenium-via-draft', async (req, res) => {
  try {
    const { saveDraftArticleViaSelenium } = require('./selenium-draft');
    console.log('🚀 正在使用 Selenium 执行草稿列表回编发布...');

    const result = await saveDraftArticleViaSelenium({
      ...(req.body || {}),
      publish: true,
      autoSaveOnly: false,
      publishViaDraftList: true
    });

    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 直接回放桌面浏览器的 publish 请求以保存草稿
app.post('/api/mp/article/publish/http', async (req, res) => {
  try {
    const { publishDraftViaHttp } = require('./mp-client');
    console.log('📨 正在回放 publish 请求保存草稿...');

    const result = await publishDraftViaHttp(req.body || {});

    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API: 清理旧数据
app.post('/api/cleanup', (req, res) => {
  try {
    const days = parseInt(req.query.days) || config.dataRetentionDays;
    const cleaned = storage.cleanupOldData(days);
    res.json({ success: true, cleaned });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 定时任务：每 10 分钟抓取一次
cron.schedule(config.scrapeInterval, async () => {
  console.log(`⏰ [${formatLocalDateTime()}] 定时抓取开始`);
  try {
    await scrapeHotSearches();
    
    // 定期清理旧数据（每天凌晨 2 点）
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
      storage.cleanupOldData(config.dataRetentionDays);
    }
  } catch (error) {
    console.error('❌ 定时抓取失败:', error);
  }
});

// 启动服务器
app.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║          🔥 头条热点监测工具已启动                      ║
╠════════════════════════════════════════════════════════╣
║  📊 Web 界面：http://localhost:${PORT}                     ║
║  ⏰ 抓取间隔：每 10 分钟                                   ║
║  📁 数据保留：${config.dataRetentionDays} 天                               ║
║  🛑 按 Ctrl+C 停止                                       ║
╚════════════════════════════════════════════════════════╝
  `);
});
