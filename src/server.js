const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const storage = require('./storage');
const { scrapeHotSearches } = require('./scraper');
const config = require('../config.json');

const app = express();
const PORT = config.port || 3000;

app.use(cors());
app.use(express.json());
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
    res.json({ success: true, data: rising });
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
    
    res.json({ success: true, data: rising });
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
  console.log(`⏰ [${new Date().toISOString()}] 定时抓取开始`);
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
app.listen(PORT, () => {
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
