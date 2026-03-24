/**
 * 使用 agent-browser 获取头条实时热点
 */
async function fetchHotSearchesViaBrowser() {
  const { execSync } = require('child_process');
  const sourceUrls = [
    'https://www.toutiao.com/',
    'https://www.toutiao.com/?channel=all&source=mine_profile'
  ];
  
  console.log('🌐 使用 agent-browser 获取头条热点（多来源）...');
  
  try {
    const mergedByTopic = new Map();
    let discoveredIndex = 0;

    for (const sourceUrl of sourceUrls) {
      try {
        console.log(`📡 正在访问页面：${sourceUrl}`);
        execSync(`agent-browser open "${sourceUrl}"`, {
          stdio: 'pipe',
          timeout: 30000
        });

        console.log('⏳ 等待页面加载...');
        await sleep(10000);

        console.log('📸 正在获取页面快照...');
        const snapshotOutput = execSync('agent-browser snapshot -i --json', {
          encoding: 'utf8',
          timeout: 30000
        });

        const snapshot = JSON.parse(snapshotOutput);
        if (!snapshot.data || !snapshot.data.snapshot) {
          console.log(`⚠️ 页面无快照文本：${sourceUrl}`);
          continue;
        }

        let localItems = [];
        try {
          localItems = fetchHotItemsFromDom(execSync);
        } catch (domError) {
          console.log(`⚠️ DOM 提取失败，回退到快照解析：${domError.message}`);
        }

        if (localItems.length === 0) {
          localItems = extractFromSnapshotText(snapshot.data.snapshot, sourceUrl);
        }
        const localCount = localItems.length;

        localItems.forEach((item) => {
          discoveredIndex += 1;
          const key = normalizeTopicKey(item.topic);
          const existing = mergedByTopic.get(key);
          const next = {
            ...item,
            _discoveredIndex: discoveredIndex
          };

          if (!existing) {
            mergedByTopic.set(key, next);
            return;
          }

          const existingRank = Number.isFinite(existing.rank) ? existing.rank : Number.MAX_SAFE_INTEGER;
          const nextRank = Number.isFinite(next.rank) ? next.rank : Number.MAX_SAFE_INTEGER;
          if (nextRank < existingRank) {
            mergedByTopic.set(key, next);
          }
        });

        console.log(`✅ 来源抓取到 ${localCount} 条候选热点：${sourceUrl}`);
      } catch (err) {
        console.log(`⚠️ 来源抓取失败，跳过：${sourceUrl} (${err.message})`);
      }
    }

    const hotSearches = normalizeHotResults(Array.from(mergedByTopic.values())).slice(0, 50);
    
    // 5. 关闭浏览器
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    
    if (hotSearches.length > 0) {
      console.log(`✅ 合并后获取到 ${hotSearches.length} 条热点`);
    } else {
      console.log('⚠️ 未获取到热点数据');
    }
    
    return hotSearches;
    
  } catch (error) {
    console.error('❌ 获取热点失败:', error.message);
    try {
      execSync('agent-browser close', { stdio: 'pipe', timeout: 5000 });
    } catch (e) {}
    return [];
  }
}

function fetchHotItemsFromDom(execSync) {
  const evalOutput = execSync(`agent-browser eval '${buildHotListEvalScript()}'`, {
    encoding: 'utf8',
    timeout: 30000
  });

  const parsed = JSON.parse(evalOutput.trim());
  if (!Array.isArray(parsed)) {
    return [];
  }

  const deduped = new Map();
  for (const item of parsed) {
    const normalized = normalizeDomHotItem(item);
    if (!normalized) continue;

    const key = `${normalizeTopicKey(normalized.topic)}|${normalized.url}`;
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }

  return Array.from(deduped.values());
}

function buildHotListEvalScript() {
  return `(() => {
    const normalize = (value) => String(value || "").trim();
    const isCandidateHref = (href) => {
      const value = String(href || "");
      return value.startsWith("https://www.toutiao.com/trending/")
        || value.startsWith("https://www.toutiao.com/article/")
        || value.startsWith("https://www.toutiao.com/video/");
    };
    const elements = Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span"));
    const heading = elements.find((el) => normalize(el.textContent) === "头条热榜");

    const collectAnchors = (root) => Array.from(root.querySelectorAll("a[href]")).map((a) => ({
      text: normalize(a.textContent),
      href: a.href
    })).filter((item) => item.text && isCandidateHref(item.href));

    const candidates = [];
    let current = heading;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      const anchors = collectAnchors(current);
      const score = anchors.filter((item) => {
        const firstChar = item.text.slice(0, 1);
        const startsWithDigit = firstChar >= "0" && firstChar <= "9";
        return startsWithDigit || item.href.includes("rank=");
      }).length;
      candidates.push({ anchors, score });
      current = current.parentElement;
    }

    const bestCandidate = candidates.sort((a, b) => b.score - a.score || b.anchors.length - a.anchors.length)[0];
    const anchors = (bestCandidate && bestCandidate.score > 0 ? bestCandidate.anchors : collectAnchors(document.body)).slice(0, 80);

    return anchors.map((item) => ({
      text: item.text,
      href: item.href
    }));
  })()`;
}

function normalizeDomHotItem(item) {
  const href = canonicalizeToutiaoUrl(item?.href);
  const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
  if (!href || !text) return null;

  const parsed = parseHotDomText(text, href);
  if (!parsed || !parsed.title || !isValidHotTopicTitle(parsed.title)) {
    return null;
  }

  return {
    rank: parsed.rank,
    topic: parsed.title,
    heat: null,
    trend: 'stable',
    category: categorizeTopic(parsed.title),
    url: href
  };
}

function parseHotDomText(text, href) {
  const hrefRankMatch = String(href).match(/[?&]rank=(\d{1,2})\b/);
  const prefixRankMatch = text.match(/^(\d{1,2})(.+)$/);

  let rank = null;
  let title = text;

  if (hrefRankMatch) {
    rank = parseInt(hrefRankMatch[1], 10);
    if (prefixRankMatch) {
      title = prefixRankMatch[2].trim();
    }
  } else if (prefixRankMatch) {
    const possibleRank = parseInt(prefixRankMatch[1], 10);
    if (possibleRank >= 1 && possibleRank <= 50) {
      rank = possibleRank;
      title = prefixRankMatch[2].trim();
    }
  }

  title = cleanTitle(title);
  if (!title) return null;

  return { rank, title };
}

function canonicalizeToutiaoUrl(url) {
  const value = String(url || '').trim();
  if (!/^https:\/\/www\.toutiao\.com\/(trending|article|video)\//.test(value)) {
    return null;
  }
  return value.replace(/#comment$/, '');
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/^\d{1,2}\s*/, '')
    .replace(/^[\.、:：\-|｜]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFromSnapshotText(snapshotText, sourceUrl) {
  const lines = String(snapshotText || '').split('\n');
  const results = [];
  let inHotList = false;

  for (const line of lines) {
    if (line.includes('头条热榜')) {
      inHotList = true;
      continue;
    }

    if (!inHotList) continue;

    // 热榜区块结束标识
    if (line.includes('热门视频') || line.includes('更多热点') || line.includes('热榜') && line.includes('展开')) {
      break;
    }

    const match = line.match(/- link "([^"]+)" \[ref=e\d+\]/);
    if (!match) continue;

    const parsed = parseHotRefName(match[1]);
    if (!parsed) continue;
    if (!isValidHotTopicTitle(parsed.title)) continue;

    results.push({
      rank: parsed.rank,
      topic: parsed.title,
      heat: null,
      trend: 'stable',
      category: categorizeTopic(parsed.title),
      url: null
    });
  }

  return results;
}

function parseHotRefName(rawName) {
  const text = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // 仅接受“排名 + 分隔符 + 标题”，避免把“2025跨年手机推荐”误识别为 rank=2025
  const strictRankMatch = text.match(/^(\d{1,2})\s*[\.、:：\-|｜]\s*(.+)$/);
  if (strictRankMatch) {
    const rank = parseInt(strictRankMatch[1], 10);
    const title = strictRankMatch[2].trim();
    if (rank >= 1 && rank <= 50 && title) {
      return { rank, title };
    }
  }

  // 兼容 “1 标题” 的格式（要求有空格）
  const looseRankMatch = text.match(/^(\d{1,2})\s+(.+)$/);
  if (looseRankMatch) {
    const rank = parseInt(looseRankMatch[1], 10);
    const title = looseRankMatch[2].trim();
    if (rank >= 1 && rank <= 50 && title) {
      return { rank, title };
    }
  }

  // 没有可靠 rank 时仅返回标题，后续统一重排排名
  return { rank: null, title: text };
}

function isValidHotTopicTitle(title) {
  if (!title) return false;
  if (title.length < 4 || title.length > 80) return false;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(title)) return false;
  const blacklist = [
    '头条热榜', '热搜', '热门视频', '登录', '注册', '首页', '更多',
    '许可证', '备案', '京公网安备', 'ICP', '网信算备', '跟帖评论', '自律管理承诺书',
    '广播电视节目制作经营许可证', '网络文化经营许可证'
  ];
  return !blacklist.some((word) => title === word);
}

function normalizeTopicKey(topic) {
  return String(topic || '').replace(/[\s\u3000]+/g, '').trim();
}

function normalizeHotResults(items) {
  const sorted = items.sort((a, b) => {
    const rankA = Number.isFinite(a.rank) ? a.rank : Number.MAX_SAFE_INTEGER;
    const rankB = Number.isFinite(b.rank) ? b.rank : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return (a._discoveredIndex || Number.MAX_SAFE_INTEGER) - (b._discoveredIndex || Number.MAX_SAFE_INTEGER);
  });

  let fallbackRank = 1;

  return sorted.map((item, idx) => {
    while (sorted.some((entry) => Number.isFinite(entry.rank) && entry.rank === fallbackRank)) {
      fallbackRank += 1;
    }

    const rank = Number.isFinite(item.rank) ? item.rank : fallbackRank++;
    return {
      rank,
      topic: item.topic,
      heat: item.heat ?? null,
      trend: rank <= 3 ? 'new' : rank <= 10 ? 'up' : 'stable',
      category: item.category || categorizeTopic(item.topic),
      url: item.url
    };
  });
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
