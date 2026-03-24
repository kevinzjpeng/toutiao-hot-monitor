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
    
    return data.data.map(article => ({
      title: article.title,
      url: article.article_url,
      createTime: article.create_time,
      readCount: article.read_count,
      commentCount: article.comment_count,
      diggCount: article.digg_count
    }));
    
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
    
    // 4. 解析文章列表
    const refs = snapshot.data.refs;
    const articles = [];
    
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
          title: v.name.trim()
        });
      }
    });
    
    // 5. 关闭浏览器
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
  
  // 方法 0: 优先读取已缓存的文章数据
  const cachedPath = path.join(__dirname, '../data/user-articles.json');
  if (fs.existsSync(cachedPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
      if (cached.articles && cached.articles.length > 0) {
        console.log(`📁 读取缓存文章：${cached.articles.length} 篇`);
        return cached.articles;
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
