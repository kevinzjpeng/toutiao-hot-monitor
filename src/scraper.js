const { execSync } = require('child_process');
const storage = require('./storage');
const config = require('../config.json');

const TOUTIAO_HOME_URL = 'https://www.toutiao.com/';
const TOUTIAO_HOT_URL = 'https://www.toutiao.com/hot/'; // 已废弃，返回 404
const path = require('path');
const fs = require('fs');

// 用户信息文件路径
const USER_INFO_PATH = path.join(__dirname, '../data/user-info.json');

function formatLocalDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function applyConfiguredCookies() {
  const cookies = config.cookies || {};
  const cookieNames = [
    'tt_webid',
    'sessionid',
    'sid_tt',
    'passport_auth_status',
    'toutiao_sso_user',
    'uid_tt',
    'ttwid'
  ];

  cookieNames.forEach((cookieName) => {
    const value = cookies[cookieName];
    if (value) {
      try {
        const escapedValue = String(value)
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\$/g, '\\$');
        execSync(`agent-browser cookies set ${cookieName} "${escapedValue}"`, {
          stdio: 'pipe',
          timeout: 8000
        });
      } catch (e) {
        console.log(`⚠️ Cookie 设置失败，已跳过 ${cookieName}: ${e.message}`);
      }
    }
  });
}

function runAgentEval(script, timeout = 30000) {
  const payload = String(script)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ');

  return execSync(`agent-browser eval "${payload}"`, {
    encoding: 'utf8',
    timeout
  });
}

/**
 * 使用 agent-browser 抓取头条热搜数据
 */
async function scrapeHotSearches() {
  console.log(`🔍 开始抓取头条热榜：${TOUTIAO_HOME_URL}`);
  
  const snapshotTime = formatLocalDateTime();
  
  try {
    // 先获取用户信息（可选）
    await fetchUserInfo().catch(e => console.log('⚠️ 获取用户信息失败:', e.message));
    
    // 使用 browser-scraper 获取实时热点
    const { fetchHotSearchesViaBrowser } = require('./browser-scraper');
    const hotSearches = await fetchHotSearchesViaBrowser();
    
    if (hotSearches && hotSearches.length > 0) {
      storage.saveHotSearches(hotSearches, snapshotTime);
      console.log(`✅ 抓取完成，共 ${hotSearches.length} 条热点`);
      return hotSearches;
    } else {
      console.log('⚠️ 未获取到热点数据，使用演示数据');
      const demoData = generateDemoData();
      storage.saveHotSearches(demoData, snapshotTime);
      return demoData;
    }
  } catch (error) {
    console.error('❌ 抓取失败:', error.message);
    console.log('⚠️ 使用演示数据');
    const demoData = generateDemoData();
    storage.saveHotSearches(demoData, snapshotTime);
    return demoData;
  }
}

/**
 * 使用 agent-browser 获取头条用户信息
 */
async function fetchUserInfo() {
  console.log('👤 正在获取用户信息...');
  
  try {
    const { execSync } = require('child_process');

    // 1. 先打开页面，再设置 Cookie（避免部分 cookie 字段校验失败）
    execSync(`agent-browser open "${TOUTIAO_HOME_URL}"`, { stdio: 'pipe', timeout: 30000 });
    await sleep(1500);

    try {
      applyConfiguredCookies();
    } catch (e) {
      console.log('⚠️ Cookie 设置失败，继续尝试访问:', e.message);
    }

    // 2. 重新打开页面使 Cookie 生效
    execSync(`agent-browser open "${TOUTIAO_HOME_URL}"`, { stdio: 'pipe', timeout: 30000 });
    await sleep(3000);

    // 3. 执行 JS 获取用户信息
    const userInfoOutput = runAgentEval(`
      (() => {
        const root = document.querySelector('.user-info') || document.querySelector('[class*=user]');
        if (!root) return { found: false };

        const name = (root.textContent || '').trim();
        const avatar = (root.querySelector('img') && root.querySelector('img').src) || null;

        const container = root.parentElement || root;
        const statText = Array.from(container.querySelectorAll('span'))
          .map((el) => (el.textContent || '').trim())
          .join(' ');

        const nums = (statText.match(/\d+/g) || []).map((n) => Number(n));
        return {
          found: true,
          name,
          avatar,
          fans: nums.length > 0 ? nums[0] : null,
          follow: nums.length > 1 ? nums[1] : null,
          likes: nums.length > 2 ? nums[2] : null,
          stats: statText
        };
      })()
    `, 30000);
    
    let userInfo;
    try {
      userInfo = JSON.parse(userInfoOutput.trim());
    } catch (e) {
      console.log('⚠️ 解析用户信息失败');
      return null;
    }
    
    if (userInfo && userInfo.found) {
      // 4. 获取用户主页链接和 token
      const linkOutput = runAgentEval(`
        (() => {
          const link = document.querySelector('a[href*="/c/user/token/"]') || document.querySelector('a[href*="user/token/"]');
          if (!link || !link.href) return null;

          const href = link.href;
          const marker = '/token/';
          const index = href.indexOf(marker);
          if (index < 0) return { href, token: null };
          const rest = href.slice(index + marker.length);
          const token = rest.split('/')[0].split('?')[0];
          return { href, token: token || null };
        })()
      `, 10000);
      
      try {
        const linkInfo = JSON.parse(linkOutput.trim());
        if (linkInfo) {
          userInfo.homepageUrl = linkInfo.href;
          userInfo.token = linkInfo.token;
        }
      } catch (e) {
        // 忽略链接获取失败
      }
      
      // 5. 保存用户信息
      saveUserInfo(userInfo);
      
      console.log(`✅ 用户信息：${userInfo.name} | 粉丝:${userInfo.fans || '-'} | 关注:${userInfo.follow || '-'} | 获赞:${userInfo.likes || '-'}`);
      
      // 6. 关闭浏览器
      try {
        execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
      } catch (e) {}
      
      return userInfo;
    } else {
      console.log('⚠️ 未找到用户信息（可能未登录）');
      return null;
    }
  } catch (error) {
    console.error('❌ 获取用户信息失败:', error.message);
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    return null;
  }
}

/**
 * 保存用户信息到文件
 */
function saveUserInfo(userInfo) {
  const data = {
    ...userInfo,
    updatedAt: new Date().toISOString()
  };
  
  fs.writeFileSync(USER_INFO_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log(`📁 用户信息已保存：${USER_INFO_PATH}`);
}

/**
 * 获取保存的用户信息
 */
function getCachedUserInfo() {
  try {
    if (fs.existsSync(USER_INFO_PATH)) {
      const data = fs.readFileSync(USER_INFO_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    // 忽略读取失败
  }
  return null;
}

/**
 * 通过 agent-browser 抓取头条热榜
 */
async function fetchHotSearchesViaBrowser() {
  try {
    // 1. 设置 Cookie
    console.log('🍪 正在设置 Cookie...');
    try {
      applyConfiguredCookies();
    } catch (e) {
      console.log('⚠️ Cookie 设置跳过（可能已存在）');
    }
    
    // 2. 打开头条首页
    console.log('📡 正在打开页面...');
    execSync(`agent-browser open "${TOUTIAO_HOME_URL}"`, {
      stdio: 'pipe',
      timeout: 30000
    });
    
    // 等待页面加载
    await sleep(3000);
    
    // 2. 获取页面快照
    console.log('📸 正在获取页面快照...');
    const snapshotOutput = execSync('agent-browser snapshot -i --json', {
      encoding: 'utf8',
      timeout: 30000
    });
    
    // 3. 解析快照数据
    let snapshot;
    try {
      snapshot = JSON.parse(snapshotOutput);
    } catch (e) {
      console.error('解析快照失败:', e.message);
      return null;
    }
    
    // 4. 提取热榜数据
    const hotSearches = extractHotSearchesFromSnapshot(snapshot);
    
    // 5. 关闭浏览器
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {
      // 忽略关闭错误
    }
    
    return hotSearches;
  } catch (error) {
    console.error('agent-browser 执行失败:', error.message);
    
    // 尝试关闭浏览器
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    
    return null;
  }
}

/**
 * 从快照中提取热榜数据
 */
function extractHotSearchesFromSnapshot(snapshot) {
  const hotSearches = [];
  
  if (!snapshot || !snapshot.data || !snapshot.data.snapshot) {
    return [];
  }
  
  const snapshotText = snapshot.data.snapshot;
  
  // 查找"头条热榜"标题后的链接
  const lines = snapshotText.split('\n');
  let inHotList = false;
  let rank = 0;
  
  for (const line of lines) {
    // 检测是否进入热榜区域
    if (line.includes('头条热榜')) {
      inHotList = true;
      continue;
    }
    
    // 检测是否离开热榜区域（遇到"热门视频"标题）
    if (line.includes('热门视频') && inHotList) {
      break;
    }
    
    // 在热榜区域内提取链接
    if (inHotList) {
      // 匹配 link 行，格式如：- link "内容" [ref=exx]
      const match = line.match(/- link "([^"]+)" \[ref=e\d+\]/);
      if (match) {
        const topic = match[1].trim();
        
        // 过滤无效内容
        if (isValidHotTopic(topic)) {
          rank++;
          hotSearches.push({
            rank: rank,
            topic: cleanText(topic),
            heat: null,
            trend: rank <= 3 ? 'new' : rank <= 10 ? 'up' : 'stable',
            category: categorizeTopic(topic)
          });
        }
      }
    }
  }
  
  return hotSearches;
}

/**
 * 判断是否是有效的热榜话题
 */
function isValidHotTopic(text) {
  if (!text || text.length < 2 || text.length > 100) return false;
  
  // 排除常见非热榜内容
  const excludePatterns = [
    /^首页$/, /^热点$/, /^视频$/, /^直播$/, /^我的$/,
    /^登录$/, /^注册$/, /^下载$/, /^APP$/,
    /^©/, /^京 ICP/, /^京公网安备/,
    /^搜索$/, /^请输入$/, /^热门$/, /^推荐$/,
    /^加入头条$/, /^用户协议$/, /^隐私政策$/,
    /^媒体合作$/, /^广告合作$/, /^友情链接$/,
    /^扫黄打非/, /^网络谣言/, /^网上有害/,
    /^侵权举报$/, /^京 ICP 证/, /^网络文化经营/,
    /^营业执照$/, /^广播电视/, /^出版物经营/,
    /^营业性演出/, /^药品医疗器械/, /^互联网宗教/,
    /^跟帖评论$/, /^网信算备/
  ];
  
  for (const pattern of excludePatterns) {
    if (pattern.test(text.trim())) return false;
  }
  
  // 必须包含中文字符
  return /[\u4e00-\u9fa5]/.test(text);
}

/**
 * 清理文本
 */
function cleanText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/，$/, '')  // 移除末尾逗号
    .trim();
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 对新闻话题进行分类
 */
function categorizeTopic(topic) {
  const categories = {
    '政治': ['习近平', '总理', '国务院', '两会', '政治局', '常委', '考察', '会议', '雄安', '党建', '政府', '政策', '改革', '外交', '金正恩', '普京', '拜登', '总统', '主席', '会谈', '峰会'],
    '财经': ['油价', '成品油', '股票', '股市', '基金', '银行', '利率', '黄金', '卖金', '套现', '房价', '楼市', '房地产', '经济', 'GDP', '金融', '投资', '理财', '姚洋'],
    '科技': ['华为', '鸿蒙', '余承东', '发布会', '手机', '芯片', 'AI', '人工智能', '5G', '互联网', '软件', '数码', 'APP', '系统', '新能源', '电池', '卫星', '航天'],
    '体育': ['郑钦文', '萨巴伦卡', '网球', '足球', '篮球', '世界杯', '奥运', '冠军', '比赛', '运动员', '教练', '球队', '乒乓球', '羽毛球', '游泳', '田径'],
    '娱乐': ['演唱会', '电影', '电视剧', '演员', '歌手', '明星', '综艺', '晚会', '颁奖', '绯闻', '恋情', '离婚', '结婚', '出道', '专辑', '直播', '网红'],
    '社会': ['地铁', '医院', '学校', '学生', '老师', '医生', '警察', '火灾', '事故', '车祸', '案件', '判决', '法院', '抢婴', '二审', '宣判', '入室', '曝光', '调查', '立案'],
    '国际': ['美伊', '伊朗', '美国', '俄罗斯', '乌克兰', '以色列', '朝鲜', '韩国', '日本', '中东', '战争', '冲突', '制裁', '导弹', '军事', '核武', '拥核', '罗生门'],
    '健康': ['医疗', '健康', '疫苗', '病毒', '疫情', '减肥', '健身', '食品', '安全', '检测', '超标', '有害'],
    '其他': []
  };
  
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.length === 0) continue;
    for (const keyword of keywords) {
      if (topic.includes(keyword)) return category;
    }
  }
  return '其他';
}

/**
 * 生成演示数据
 */
function generateDemoData() {
  const demoTopics = [
    '2026 年全国两会召开',
    '人工智能技术新突破',
    '春节假期安排公布',
    '新能源汽车销量创新高',
    '国际油价大幅波动',
    '科技创新发展规划',
    '高校毕业生就业政策',
    '房地产市场新动态',
    '医疗健康改革进展',
    '数字经济发展报告',
    '环保政策新举措',
    '文化旅游市场复苏',
    '体育赛事精彩瞬间',
    '娱乐圈热点新闻',
    '科技产品发布会',
    '国际关系新进展',
    '金融市场走势分析',
    '教育改革新政策',
    '社会保障体系完善',
    '乡村振兴成果展示'
  ];
  
  return demoTopics.map((topic, index) => ({
    rank: index + 1,
    topic: topic,
    heat: String(Math.floor(Math.random() * 1000000) + 100000),
    trend: index < 3 ? 'new' : index < 10 ? 'up' : index < 15 ? 'stable' : 'down'
  }));
}

// 命令行执行
if (require.main === module) {
  scrapeHotSearches().catch(console.error);
}

module.exports = {
  scrapeHotSearches,
  fetchUserInfo,
  getCachedUserInfo,
  fetchHotSearchesViaBrowser,
  extractHotSearchesFromSnapshot,
  generateDemoData
};
