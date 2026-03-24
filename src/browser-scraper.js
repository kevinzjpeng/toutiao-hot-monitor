/**
 * 使用 agent-browser 获取头条实时热点
 */
async function fetchHotSearchesViaBrowser() {
  const { execSync } = require('child_process');
  
  console.log('🌐 使用 agent-browser 获取头条热点...');
  
  try {
    // 1. 打开头条首页
    console.log('📡 正在访问头条首页...');
    execSync('agent-browser open "https://www.toutiao.com/"', {
      stdio: 'pipe',
      timeout: 30000
    });
    
    // 2. 等待页面加载
    console.log('⏳ 等待页面加载...');
    await sleep(10000);
    
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
    
    // 4. 解析热点数据
    const refs = snapshot.data.refs;
    const hotSearches = [];
    
    // 查找热榜区域
    let inHotList = false;
    let rank = 0;
    
    Object.values(refs).forEach(v => {
      if (!v.name || v.name.length < 2 || v.name.length > 100) return;
      
      // 检测热榜区域
      if (v.name.includes('头条热榜') || v.name.includes('热搜')) {
        inHotList = true;
        return;
      }
      
      // 解析热榜项目（格式：数字 + 标题）
      if (inHotList) {
        const match = v.name.match(/^(\d+)(.*)$/);
        if (match) {
          rank = parseInt(match[1]);
          const title = match[2].trim();
          if (title.length > 0 && title.length < 80) {
            hotSearches.push({
              rank: rank,
              topic: title,
              heat: null,
              trend: rank <= 3 ? 'new' : rank <= 10 ? 'up' : 'stable',
              category: categorizeTopic(title)
            });
          }
        }
      }
    });
    
    // 5. 关闭浏览器
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    
    if (hotSearches.length > 0) {
      console.log(`✅ 获取到 ${hotSearches.length} 条热点`);
    } else {
      console.log('⚠️ 未获取到热点数据');
    }
    
    return hotSearches.slice(0, 50);
    
  } catch (error) {
    console.error('❌ 获取热点失败:', error.message);
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    return [];
  }
}

/**
 * 获取科技/生活类文章
 */
async function fetchTechLifeArticles() {
  const { execSync } = require('child_process');
  
  console.log('📱 获取科技/生活类文章...');
  
  try {
    // 1. 打开头条首页
    execSync('agent-browser open "https://www.toutiao.com/"', {
      stdio: 'pipe',
      timeout: 30000
    });
    
    await sleep(10000);
    
    // 2. 执行 JS 获取文章列表
    const evalOutput = execSync('agent-browser eval "(() => { const articles = document.querySelectorAll(\'[class*=article], [class*=item], [class*=feed], [role=article]\'); const result = []; articles.forEach(a => { const title = a.querySelector(\'[class*=title], h2, h3, [class*=text]\')?.textContent?.trim(); const time = a.querySelector(\'[class*=time], [class*=date], [class*=ago]\')?.textContent?.trim(); const views = a.querySelector(\'[class*=view], [class*=read], [class*=hot]\')?.textContent?.trim(); if(title && title.length > 5 && title.length < 80) result.push({ title, time: time || \'\', views: views || \'\' }); }); return result.filter(r => r.title.includes(\'科技\') || r.title.includes(\'生活\') || r.title.includes(\'AI\') || r.title.includes(\'智能\') || r.title.includes(\'3D\') || r.title.includes(\'打印\') || r.title.includes(\'华为\') || r.title.includes(\'数码\') || r.title.includes(\'汽车\')).slice(0, 20); })()"', {
      encoding: 'utf8',
      timeout: 30000
    });
    
    let articles;
    try {
      articles = JSON.parse(evalOutput.trim());
    } catch (e) {
      console.log('⚠️ 解析文章列表失败');
      return [];
    }
    
    // 3. 关闭浏览器
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    
    if (articles.length > 0) {
      console.log(`✅ 获取到 ${articles.length} 篇科技/生活文章`);
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
 * 获取上升最快的文章（对比两次快照）
 */
async function getFastestRisingArticles() {
  const storage = require('./storage');
  
  console.log('📈 分析上升最快的文章...');
  
  // 获取最近两次快照
  const data = storage.getAllData();
  if (data.snapshots.length < 2) {
    console.log('⚠️ 数据不足，需要至少 2 次快照');
    return [];
  }
  
  const latest = data.snapshots[data.snapshots.length - 1];
  const previous = data.snapshots[data.snapshots.length - 2];
  
  // 建立上次的排名映射
  const prevRankMap = new Map();
  previous.items.forEach(item => {
    prevRankMap.set(item.topic, item.rank);
  });
  
  // 计算排名变化
  const rising = latest.items.map(item => {
    const prevRank = prevRankMap.get(item.topic);
    const rankChange = prevRank ? prevRank - item.rank : null;
    const isNew = !prevRank;
    
    return {
      ...item,
      prevRank: prevRank || null,
      rankChange: rankChange,
      isNew: isNew,
      risingSpeed: isNew ? 999 : (rankChange || 0)
    };
  });
  
  // 按上升速度排序
  rising.sort((a, b) => b.risingSpeed - a.risingSpeed);
  
  // 筛选科技/生活类
  const techLifeRising = rising.filter(item => 
    item.category === '科技' || item.category === '财经' || item.category === '社会'
  );
  
  console.log(`✅ 找到 ${techLifeRising.length} 篇上升最快的科技/生活文章`);
  
  return techLifeRising.slice(0, 10);
}

/**
 * 对新闻话题进行分类
 */
function categorizeTopic(topic) {
  const categories = {
    '政治': ['习近平', '总理', '国务院', '两会', '政治局', '常委', '考察', '会议', '雄安', '党建', '政府', '政策', '改革', '外交', '金正恩', '普京', '拜登', '总统', '主席', '会谈', '峰会'],
    '财经': ['油价', '成品油', '股票', '股市', '基金', '银行', '利率', '黄金', '卖金', '套现', '房价', '楼市', '房地产', '经济', 'GDP', '金融', '投资', '理财', '姚洋', 'A 股', '高开'],
    '科技': ['华为', '鸿蒙', '余承东', '发布会', '手机', '芯片', 'AI', '人工智能', '5G', '互联网', '软件', '数码', 'APP', '系统', '新能源', '电池', '卫星', '航天', '激光雷达', 'Mate'],
    '体育': ['郑钦文', '萨巴伦卡', '网球', '足球', '篮球', '世界杯', '奥运', '冠军', '比赛', '运动员', '教练', '球队', '乒乓球', '羽毛球', '游泳', '田径'],
    '娱乐': ['演唱会', '电影', '电视剧', '演员', '歌手', '明星', '综艺', '晚会', '颁奖', '绯闻', '恋情', '离婚', '结婚', '出道', '专辑', '直播', '网红'],
    '社会': ['地铁', '医院', '学校', '学生', '老师', '医生', '警察', '火灾', '事故', '车祸', '案件', '判决', '法院', '抢婴', '二审', '宣判', '入室', '曝光', '调查', '立案', '梅姨', '养老金', '工资'],
    '国际': ['美伊', '伊朗', '美国', '俄罗斯', '乌克兰', '以色列', '朝鲜', '韩国', '日本', '中东', '战争', '冲突', '制裁', '导弹', '军事', '核武', '拥核', '罗生门', '联合国', '叙利亚'],
    '健康': ['医疗', '健康', '疫苗', '病毒', '疫情', '减肥', '健身', '食品', '安全', '检测', '超标', '有害', '活鱼麻醉'],
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 命令行执行
if (require.main === module) {
  console.log('\\n🚀 开始获取头条热点\\n');
  
  fetchHotSearchesViaBrowser().then(hotSearches => {
    console.log('\\n🔥 热点榜单\\n');
    hotSearches.slice(0, 10).forEach((h, i) => {
      console.log(`${i + 1}. [${h.category}] ${h.topic}`);
    });
    
    console.log('\\n\\n📱 获取科技/生活文章...\\n');
    return fetchTechLifeArticles();
  }).then(articles => {
    if (articles && articles.length > 0) {
      console.log('\\n📋 科技/生活文章\\n');
      articles.forEach((a, i) => {
        console.log(`${i + 1}. ${a.title} (${a.time || '未知时间'})`);
      });
    }
    
    console.log('\\n\\n📈 上升最快的文章\\n');
    return getFastestRisingArticles();
  }).then(rising => {
    if (rising && rising.length > 0) {
      rising.forEach((a, i) => {
        const change = a.rankChange > 0 ? `+${a.rankChange}` : a.rankChange;
        console.log(`${i + 1}. [${a.category}] ${a.topic} (排名变化：${change})`);
      });
    }
  }).catch(console.error);
}

module.exports = { 
  fetchHotSearchesViaBrowser, 
  fetchTechLifeArticles, 
  getFastestRisingArticles,
  categorizeTopic
};
