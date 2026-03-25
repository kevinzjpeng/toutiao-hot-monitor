/**
 * 获取用户发表的文章列表
 * @param {string} userId - 用户 ID
 * @param {object} cookies - Cookie 对象
 * @returns {Promise<Array>} 文章列表
 */
async function fetchUserArticles(userId, cookies = {}) {
  const { execSync } = require('child_process');
  
  console.log(`📝 正在获取用户文章：userId=${userId}`);
  
  try {
    // 构建 cookie 字符串
    const cookieString = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    
    // 使用 curl 获取文章列表
    const url = `https://www.toutiao.com/c/user/article/?page_type=0&user_id=${userId}&max_behot_time=0&count=20`;
    
    const result = execSync(`curl -s "${url}" -H "Cookie: ${cookieString}" -H "User-Agent: Mozilla/5.0"`, {
      encoding: 'utf8',
      timeout: 30000
    });
    
    const data = JSON.parse(result);
    
    if (data.login_status !== true) {
      console.log('⚠️ 未登录或 Cookie 失效');
      return [];
    }
    
    if (!data.data || data.data.length === 0) {
      console.log('ℹ️ 该用户暂未发表文章（公开 API）');
      return [];
    }
    
    console.log(`✅ 获取到 ${data.data.length} 篇文章`);
    
    const articles = [];

    for (const article of data.data) {
      const normalized = normalizeArticleFromPublicApi(article);
      if ((!normalized.relatedArticles || normalized.relatedArticles.length === 0) && normalized.url) {
        normalized.relatedArticles = await fetchRelatedArticlesFromArticleUrl(normalized.url, cookieString);
      }
      articles.push(normalized);
    }

    return articles;
    
  } catch (error) {
    console.error('❌ 获取文章失败:', error.message);
    return [];
  }
}

/**
 * 使用 agent-browser 访问头条后台获取文章列表
 * @returns {Promise<Array>} 文章列表
 */
async function fetchUserArticlesViaBackend() {
  const { execSync } = require('child_process');
  const config = require('../config.json');
  
  console.log('🌐 使用 agent-browser 访问头条后台获取文章...');
  
  try {
    const cookies = config.cookies || {};
    
    // 1. 设置 Cookie
    console.log('🍪 正在设置 Cookie...');
    try {
      if (cookies.sessionid) execSync(`agent-browser cookies set sessionid "${cookies.sessionid}"`, { stdio: 'pipe', timeout: 5000 });
      if (cookies.sid_tt) execSync(`agent-browser cookies set sid_tt "${cookies.sid_tt}"`, { stdio: 'pipe', timeout: 5000 });
      if (cookies.toutiao_sso_user) execSync(`agent-browser cookies set toutiao_sso_user "${cookies.toutiao_sso_user}"`, { stdio: 'pipe', timeout: 5000 });
      if (cookies.passport_auth_status) execSync(`agent-browser cookies set passport_auth_status "${cookies.passport_auth_status}"`, { stdio: 'pipe', timeout: 5000 });
      console.log('✅ Cookie 设置完成');
    } catch (e) {
      console.log('⚠️ Cookie 设置跳过（可能已存在）');
    }
    
    // 2. 打开管理后台
    console.log('📄 正在访问管理后台...');
    execSync('agent-browser open "https://mp.toutiao.com/profile_v4/manage/content/all"', {
      stdio: 'pipe',
      timeout: 30000
    });
    
    // 等待页面加载
    console.log('⏳ 等待页面加载...');
    await sleep(8000);
    
    // 3. 获取页面快照
    console.log('📸 正在获取页面快照...');
    const snapshotOutput = execSync('agent-browser snapshot --json --refs aria', {
      encoding: 'utf8',
      timeout: 30000
    });
    
    const snapshot = JSON.parse(snapshotOutput);
    
    if (!snapshot.data || !snapshot.data.refs) {
      console.log('⚠️ 无法获取页面内容');
      return [];
    }
    
    // 4. 优先通过 DOM 提取结构化数据
    let articles = [];
    try {
      const articleEvalOutput = execSync(`agent-browser eval "(() => {
        const toAbs = (href) => {
          if (!href) return '';
          try { return new URL(href, location.origin).toString(); } catch (e) { return href; }
        };

        const unique = new Map();
        const links = Array.from(document.querySelectorAll('a[href]'));

        const isArticleLink = (href) => {
          return /toutiao\\.com\\/(article|w\\/article)\\//.test(href || '');
        };

        const parsePublishTime = (text) => {
          const m = String(text || '').match(/(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:\\s+\\d{1,2}:\\d{1,2})?)/);
          return m ? m[1].replace(/\\./g, '-') : '';
        };

        const parseCommentCount = (text) => {
          const m = String(text || '').match(/评论\\s*(\\d+)/);
          return m ? Number(m[1]) : null;
        };

        for (const link of links) {
          const title = (link.textContent || '').trim().replace(/\\s+/g, ' ');
          const href = toAbs(link.getAttribute('href') || '');
          if (!title || title.length < 6 || !isArticleLink(href)) continue;

          const row = link.closest('tr, li, article, .item, .card, .list-item, [class*=item], [class*=card]') || link.parentElement;
          const rowText = row ? (row.textContent || '').replace(/\\s+/g, ' ') : '';
          const allRowLinks = row ? Array.from(row.querySelectorAll('a[href]')) : [];
          const relatedArticles = allRowLinks
            .map((a) => ({
              title: (a.textContent || '').trim().replace(/\\s+/g, ' '),
              url: toAbs(a.getAttribute('href') || '')
            }))
            .filter((x) => x.title && x.title !== title && isArticleLink(x.url))
            .slice(0, 5);

          if (!unique.has(title)) {
            unique.set(title, {
              title,
              url: href,
              publishTime: parsePublishTime(rowText),
              publishTimeText: parsePublishTime(rowText),
              commentCount: parseCommentCount(rowText),
              relatedArticles,
              source: 'backend-dom'
            });
          }
        }

        return JSON.stringify(Array.from(unique.values()).slice(0, 30));
      })()"`, {
        encoding: 'utf8',
        timeout: 30000
      }).trim();

      const parsed = JSON.parse(articleEvalOutput);
      if (Array.isArray(parsed) && parsed.length > 0) {
        articles = parsed;
      }
    } catch (e) {
      // Ignore and continue to snapshot fallback.
    }

    // 5. 回退：解析 snapshot refs
    if (!articles.length) {
      const refs = snapshot.data.refs;
      articles = [];
      Object.values(refs).forEach(v => {
        if (v.name &&
            v.name.length > 10 &&
            v.name.length < 100 &&
            !v.name.includes('http') &&
            !v.name.includes('请输入') &&
            !v.name.includes('登录') &&
            !v.name.includes('协议') &&
            !v.name.includes('关于') &&
            !v.name.includes('验证码') &&
            !v.name.includes('遇到问题') &&
            !v.name.includes('隐私')) {
          articles.push({
            title: v.name.trim(),
            url: '',
            publishTime: '',
            publishTimeText: '',
            commentCount: null,
            relatedArticles: [],
            source: 'backend-snapshot'
          });
        }
      });
    }

    // 6. 如果后端提取没有相关文章，尝试从文章详情页补齐（限前 10 篇）
    const top = articles.slice(0, 10);
    for (const article of top) {
      if ((!article.relatedArticles || article.relatedArticles.length === 0) && article.url) {
        article.relatedArticles = await fetchRelatedArticlesFromArticleUrl(article.url, buildCookieString(cookies));
      }
    }
    
    // 7. 关闭浏览器
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    
    if (articles.length > 0) {
      console.log(`✅ 获取到 ${articles.length} 篇文章`);
    } else {
      console.log('ℹ️ 该用户暂未发表文章');
    }
    
    return articles;
    
  } catch (error) {
    console.error('❌ 获取文章失败:', error.message);
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    return [];
  }
}

/**
 * 获取用户文章（自动选择最佳方式）
 */
async function getUserArticles(forceBackend = false) {
  const config = require('../config.json');
  const fs = require('fs');
  const path = require('path');
  
  const userId = '7163703009400886';
  const cookies = config.cookies || {};
  
  const forceRefresh = Boolean(arguments[1]);

  // 方法 0: 优先读取已缓存的文章数据
  const cachedPath = path.join(__dirname, '../data/user-articles.json');
  if (!forceRefresh && fs.existsSync(cachedPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
      if (cached.articles && cached.articles.length > 0) {
        const hasEnrichedFields = cached.articles.some(a =>
          Object.prototype.hasOwnProperty.call(a, 'publishTime') ||
          Object.prototype.hasOwnProperty.call(a, 'commentCount') ||
          Object.prototype.hasOwnProperty.call(a, 'relatedArticles')
        );

        if (hasEnrichedFields) {
          console.log(`📁 读取缓存文章：${cached.articles.length} 篇`);
          return cached.articles;
        }
      }
    } catch (e) {
      // 忽略缓存读取失败
    }
  }
  
  let articles = [];
  
  // 优先使用后台访问（更准确）
  if (forceBackend || !cookies.sessionid) {
    articles = await fetchUserArticlesViaBackend();
  } else {
    // 方法 1: 尝试公开 API
    articles = await fetchUserArticles(userId, cookies);
    
    // 方法 2: 如果公开 API 没有数据，使用后台访问
    if (articles.length === 0) {
      console.log('🔄 公开 API 无数据，尝试后台访问...');
      articles = await fetchUserArticlesViaBackend();
    }
  }
  
  // 保存结果
  if (articles.length > 0) {
    const outputPath = path.join(__dirname, '../data/user-articles.json');
    fs.writeFileSync(outputPath, JSON.stringify({
      userId,
      count: articles.length,
      articles,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
    console.log(`📁 文章数据已保存：${outputPath}`);
  }
  
  return articles;
}

function buildCookieString(cookies = {}) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function toIsoTime(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

function normalizeRelatedFromApi(article = {}) {
  const list = [];
  const push = (title, url) => {
    const t = String(title || '').trim();
    const u = String(url || '').trim();
    if (!t) return;
    list.push({ title: t, url: u });
  };

  if (Array.isArray(article.related_news)) {
    article.related_news.forEach((item) => {
      push(item && (item.title || item.name), item && (item.url || item.article_url || item.display_url));
    });
  }
  if (Array.isArray(article.related_words)) {
    article.related_words.forEach((item) => {
      push(item && (item.word || item.title || item.keyword), item && (item.url || item.link));
    });
  }

  const unique = new Map();
  list.forEach((x) => {
    if (!unique.has(x.title)) {
      unique.set(x.title, x);
    }
  });
  return Array.from(unique.values()).slice(0, 8);
}

function normalizeArticleFromPublicApi(article = {}) {
  const publishTime = toIsoTime(article.publish_time || article.create_time);
  return {
    title: article.title || '',
    url: article.article_url || article.url || '',
    publishTime,
    publishTimeText: publishTime || '',
    createTime: article.create_time || null,
    readCount: Number(article.read_count || 0),
    commentCount: Number(article.comment_count || 0),
    diggCount: Number(article.digg_count || 0),
    relatedArticles: normalizeRelatedFromApi(article),
    source: 'public-api'
  };
}

async function fetchRelatedArticlesFromArticleUrl(articleUrl, cookieString = '') {
  try {
    const response = await fetch(articleUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        cookie: cookieString
      }
    });

    if (!response.ok) return [];
    const html = await response.text();

    const matches = [];
    const re = /\"related_news\"\s*:\s*(\[[\s\S]*?\])/g;
    const matched = html.match(re);
    if (matched && matched.length) {
      const raw = matched[0].replace(/^\"related_news\"\s*:\s*/, '');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          matches.push({
            title: String((item && (item.title || item.name)) || '').trim(),
            url: String((item && (item.url || item.article_url || item.display_url)) || '').trim()
          });
        });
      }
    }

    const uniq = new Map();
    matches.forEach((x) => {
      if (x.title && !uniq.has(x.title)) {
        uniq.set(x.title, x);
      }
    });
    return Array.from(uniq.values()).slice(0, 8);
  } catch (error) {
    return [];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 命令行执行
if (require.main === module) {
  getUserArticles().then(articles => {
    console.log('\\n📝 用户文章列表\\n');
    if (articles.length > 0) {
      articles.forEach((a, i) => console.log(`${i + 1}. ${a.title}`));
    } else {
      console.log('该用户暂未发表文章');
    }
  }).catch(console.error);
}

module.exports = { 
  fetchUserArticles, 
  fetchUserArticlesViaBackend,
  getUserArticles
};
