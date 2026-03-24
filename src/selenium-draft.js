const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');

function resolveUrl(baseUrl, maybeRelative) {
  const raw = String(maybeRelative || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch (error) {
    return null;
  }
}

function extractFeaturedImageUrl(html, pageUrl) {
  const text = String(html || '');
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const url = resolveUrl(pageUrl, m[1]);
      if (url) return url;
    }
  }

  return null;
}

function guessImageExt(contentType, imageUrl) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('bmp')) return 'bmp';
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';

  const pathname = (() => {
    try { return new URL(imageUrl).pathname.toLowerCase(); } catch (e) { return ''; }
  })();

  if (pathname.endsWith('.png')) return 'png';
  if (pathname.endsWith('.webp')) return 'webp';
  if (pathname.endsWith('.gif')) return 'gif';
  if (pathname.endsWith('.bmp')) return 'bmp';
  if (pathname.endsWith('.svg')) return 'svg';
  return 'jpg';
}

async function prepareCoverImage(options = {}) {
  const explicitPath = (options.coverImagePath || '').trim();
  const explicitUrl = (options.coverImageUrl || '').trim();
  const blogUrl = (options.blogUrl || options.sourceUrl || options.articleUrl || '').trim();

  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`coverImagePath 不存在: ${explicitPath}`);
    }
    return {
      coverImagePath: explicitPath,
      coverImageSource: 'local-path',
      coverImageUrl: null,
      tempDownloaded: false
    };
  }

  let imageUrl = explicitUrl;
  if (!imageUrl && blogUrl) {
    const pageResp = await fetch(blogUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });

    if (!pageResp.ok) {
      throw new Error(`博客页面获取失败: ${pageResp.status}`);
    }

    const html = await pageResp.text();
    imageUrl = extractFeaturedImageUrl(html, blogUrl);
    if (!imageUrl) {
      throw new Error('未能从博客页面提取到 featured image (og:image)');
    }
  }

  if (!imageUrl) {
    return {
      coverImagePath: null,
      coverImageSource: null,
      coverImageUrl: null,
      tempDownloaded: false
    };
  }

  const imageResp = await fetch(imageUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'referer': blogUrl || 'https://www.beets3d.com/'
    }
  });

  if (!imageResp.ok) {
    throw new Error(`封面图片下载失败: ${imageResp.status}`);
  }

  const contentType = imageResp.headers.get('content-type') || '';
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`封面资源不是图片: ${contentType}`);
  }

  const ext = guessImageExt(contentType, imageUrl);
  const tmpPath = path.join('/tmp', `toutiao-cover-${Date.now()}.${ext}`);
  const buf = Buffer.from(await imageResp.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);

  return {
    coverImagePath: tmpPath,
    coverImageSource: explicitUrl ? 'cover-image-url' : 'blog-featured-image',
    coverImageUrl: imageUrl,
    tempDownloaded: true
  };
}

async function uploadCoverImage(driver, imagePath, timeoutMs) {
  if (!imagePath) {
    return { attempted: false, uploaded: false, reason: 'no-image-path' };
  }

  await dismissTips(driver);
  await clickButtonByText(driver, '单图');
  await driver.sleep(800);

  // Open the cover uploader panel/dialog if needed.
  await clickButtonByText(driver, '上传封面|更换封面|上传图片|本地上传');
  await driver.executeScript(
    `
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const label = Array.from(document.querySelectorAll('div,span,label,p,h4,h3'))
      .find(el => /展示封面/.test(textOf(el)));

    const clickSafe = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 40) return false;
      try { el.click(); return true; } catch (e) { return false; }
    };

    const selectors = [
      '[class*="cover"][class*="upload"]',
      '[class*="upload"][class*="cover"]',
      '[class*="cover"][class*="uploader"]',
      '[class*="uploader"][class*="cover"]',
      '[class*="cover"] [class*="upload"]',
      '[class*="upload"] [class*="cover"]'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (clickSafe(el)) return true;
    }

    if (label) {
      const base = label.closest('section, form, .byte-col, .arco-card, .arco-space, .garr-panel, div') || document.body;
      const cand = Array.from(base.querySelectorAll('div,button,span,label,a'))
        .filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 80) return false;
          const t = textOf(el);
          if (/展示封面|单图|三图|无封面|预览/.test(t)) return false;
          return true;
        })
        .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);

      for (const el of cand.slice(0, 8)) {
        if (clickSafe(el)) return true;
      }
    }

    return false;
    `
  );
  await driver.sleep(900);

  let fileInputs = await driver.findElements(By.css('input[type="file"], input[accept*="image"]'));
  if (!fileInputs.length) {
    try {
      await driver.wait(async () => {
        const els = await driver.findElements(By.css('input[type="file"], input[accept*="image"]'));
        fileInputs = els;
        return els.length > 0;
      }, Math.min(timeoutMs, 7000));
    } catch (error) {
      // Keep empty and return diagnostics below.
    }
  }
  if (!fileInputs.length) {
    const hint = await driver.executeScript(
      `
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 600);
      `
    );
    return { attempted: true, uploaded: false, reason: 'file-input-not-found', hint };
  }

  let uploaded = false;
  for (const input of fileInputs) {
    try {
      await input.sendKeys(imagePath);
      uploaded = true;
      break;
    } catch (error) {
      try {
        await driver.executeScript(
          `
          const el = arguments[0];
          if (!el) return;
          el.removeAttribute('hidden');
          el.style.display = 'block';
          el.style.visibility = 'visible';
          el.style.opacity = '1';
          el.style.width = '1px';
          el.style.height = '1px';
          `,
          input
        );
        await input.sendKeys(imagePath);
        uploaded = true;
        break;
      } catch (error2) {
        // Try next input candidate.
      }
    }
  }

  if (!uploaded) {
    return { attempted: true, uploaded: false, reason: 'send-keys-failed' };
  }

  try {
    await driver.wait(async () => {
      const state = await driver.executeScript(
        `
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const fail = /上传失败|图片格式不支持|上传出错/.test(text);
        const okHint = /更换封面|裁剪|重新上传|封面/.test(text);
        return { fail, okHint };
        `
      );
      return !!(state && (state.okHint || state.fail));
    }, Math.min(timeoutMs, 12000));
  } catch (error) {
    // Best-effort upload; continue.
  }

  return { attempted: true, uploaded: true, reason: null };
}

function parseCookieString(rawCookie) {
  if (!rawCookie || typeof rawCookie !== 'string') {
    return [];
  }

  return rawCookie
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      if (idx <= 0) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim()
      };
    })
    .filter(Boolean);
}

async function waitForReady(driver, timeoutMs) {
  await driver.wait(async () => {
    const state = await driver.executeScript('return document.readyState');
    return state === 'interactive' || state === 'complete';
  }, timeoutMs);
}

async function waitForEditorPageReady(driver, timeoutMs) {
  await driver.wait(async () => {
    try {
      return await driver.executeScript(
        `
        const state = document.readyState;
        const hasRoot = !!document.querySelector('#root, #masterRoot, .garr-panel');
        const hasEditorHint = !!document.querySelector('.ProseMirror, [contenteditable="true"], input[placeholder*="标题"], textarea[placeholder*="标题"]');
        const loadingEl = document.querySelector('.garr-loading, .byte-spin-loading-icon');
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();

        const loaded = state === 'interactive' || state === 'complete';
        const textReady = bodyText.length > 20;
        const notLoading = !loadingEl;

        return loaded && hasRoot && textReady && (hasEditorHint || notLoading);
        `
      );
    } catch (error) {
      return false;
    }
  }, timeoutMs);
}

async function clickButtonByText(driver, patternSource) {
  return driver.executeScript(
    `
    const pattern = new RegExp(arguments[0]);
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], .arco-btn, .byte-btn, a, span, div'));
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length > 40) continue;
      if (!pattern.test(text)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;

      try {
        el.click();
        return text;
      } catch (error) {
        // Continue to next candidate.
      }
    }
    return null;
    `,
    patternSource
  );
}

async function dismissTips(driver) {
  return clickButtonByText(driver, '我知道了|知道了|关闭|稍后再说');
}

async function installNetworkCapture(driver) {
  await driver.executeScript(
    `
    if (!window.__ttPublishCaptureInstalled) {
      window.__ttPublishCaptureInstalled = true;
      window.__ttPublishCapture = [];

      const pushItem = (item) => {
        try {
          if (!Array.isArray(window.__ttPublishCapture)) {
            window.__ttPublishCapture = [];
          }
          window.__ttPublishCapture.push(item);
          if (window.__ttPublishCapture.length > 100) {
            window.__ttPublishCapture.splice(0, window.__ttPublishCapture.length - 100);
          }
        } catch (e) {}
      };

      const shouldTrack = (url) => {
        const u = String(url || '');
        const lower = u.toLowerCase();
        return lower.includes('publish')
          || lower.includes('article')
          || lower.includes('draft')
          || lower.includes('graphic')
          || lower.includes('mp/agw');
      };

      const originalFetch = window.fetch;
      if (typeof originalFetch === 'function') {
        window.fetch = async function(...args) {
          const requestUrl = String(args && args[0] && args[0].url ? args[0].url : args[0] || '');
          const startedAt = Date.now();
          try {
            const response = await originalFetch.apply(this, args);
            if (shouldTrack(requestUrl)) {
              try {
                const clone = response.clone();
                const bodyText = await clone.text();
                pushItem({
                  type: 'fetch',
                  url: requestUrl,
                  status: response.status,
                  ok: response.ok,
                  body: String(bodyText || '').slice(0, 4000),
                  startedAt,
                  endedAt: Date.now()
                });
              } catch (e) {
                pushItem({
                  type: 'fetch',
                  url: requestUrl,
                  status: response.status,
                  ok: response.ok,
                  body: null,
                  startedAt,
                  endedAt: Date.now()
                });
              }
            }
            return response;
          } catch (error) {
            if (shouldTrack(requestUrl)) {
              pushItem({
                type: 'fetch',
                url: requestUrl,
                status: 0,
                ok: false,
                body: String(error && error.message ? error.message : error || '').slice(0, 1000),
                startedAt,
                endedAt: Date.now()
              });
            }
            throw error;
          }
        };
      }

      const OriginalXHR = window.XMLHttpRequest;
      if (OriginalXHR && OriginalXHR.prototype) {
        const originalOpen = OriginalXHR.prototype.open;
        const originalSend = OriginalXHR.prototype.send;

        OriginalXHR.prototype.open = function(method, url, ...rest) {
          this.__ttMethod = method;
          this.__ttUrl = url;
          return originalOpen.call(this, method, url, ...rest);
        };

        OriginalXHR.prototype.send = function(...args) {
          const startedAt = Date.now();
          this.addEventListener('loadend', function() {
            const requestUrl = String(this.__ttUrl || '');
            if (!shouldTrack(requestUrl)) return;
            let body = null;
            try {
              body = typeof this.responseText === 'string' ? this.responseText.slice(0, 4000) : null;
            } catch (e) {}
            pushItem({
              type: 'xhr',
              method: this.__ttMethod || null,
              url: requestUrl,
              status: Number(this.status || 0),
              ok: Number(this.status || 0) >= 200 && Number(this.status || 0) < 300,
              body,
              startedAt,
              endedAt: Date.now()
            });
          });
          return originalSend.apply(this, args);
        };
      }
    }

    if (Array.isArray(window.__ttPublishCapture)) {
      window.__ttPublishCapture.length = 0;
    }
    `
  );
}

async function readNetworkCapture(driver) {
  return driver.executeScript(
    `
    const list = Array.isArray(window.__ttPublishCapture) ? window.__ttPublishCapture : [];
    return list.slice(-30);
    `
  );
}

function extractBizCode(body) {
  const text = String(body || '');
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.code !== 'undefined') {
      const n = Number(parsed.code);
      return Number.isFinite(n) ? n : null;
    }
  } catch (error) {
    // Non-JSON body; try regex fallback.
  }

  const match = text.match(/"code"\s*:\s*(-?\d+)/) || text.match(/\bcode\s*=\s*(-?\d+)/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function isArticlePublishEndpoint(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('/mp/agw/article/publish') || u.includes('mp/agw/article/publish');
}

function buildPublishSignals(captured) {
  return (captured || [])
    .filter(item => /publish|article|mp\/agw|graphic/i.test(String(item && item.url ? item.url : '')))
    .map(item => ({
      type: item.type || null,
      method: item.method || null,
      url: item.url || null,
      status: Number(item.status || 0),
      bizCode: extractBizCode(item.body),
      bodySnippet: String(item.body || '').slice(0, 600)
    }));
}

function applyPublishResultFromSignals(finalResult, publishNetworkSignals) {
  const publishEndpointSignals = (publishNetworkSignals || []).filter(x => isArticlePublishEndpoint(x.url));
  const definitiveFail = publishEndpointSignals.find(x => x.bizCode !== null && x.bizCode !== 0);
  const definitiveSuccess = publishEndpointSignals.find(x => x.bizCode === 0);

  if (definitiveSuccess) {
    return {
      ...finalResult,
      ok: true,
      message: '发布成功（网络响应）'
    };
  }

  if (definitiveFail) {
    return {
      ...finalResult,
      ok: false,
      message: `发布失败（网络响应 code=${definitiveFail.bizCode}）`
    };
  }

  if (publishEndpointSignals.length > 0) {
    return {
      ...finalResult,
      ok: false,
      message: '发布结果未知（发布接口未返回可识别 code）'
    };
  }

  return finalResult;
}

async function publishViaDraftList(driver, title, timeoutMs, useCoverImage) {
  await driver.sleep(1000);
  await dismissTips(driver);
  await clickButtonByText(driver, '更多草稿|草稿箱|草稿');
  await driver.sleep(1500);

  const continueEditText = await driver.executeScript(
    `
    const targetTitle = arguments[0];
    const all = Array.from(document.querySelectorAll('button, [role="button"], .arco-btn, a, span, div'));
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

    const titleNode = all.find(el => {
      const text = textOf(el);
      return text && text.length > 6 && text.includes(targetTitle.slice(0, 10));
    });

    if (titleNode) {
      const container = titleNode.closest('li, tr, .list-item, .article-item, .draft-item, .byte-list-item, .arco-list-item') || titleNode.parentElement;
      if (container) {
        const cands = Array.from(container.querySelectorAll('button, [role="button"], .arco-btn, a, span, div'));
        for (const el of cands) {
          const text = textOf(el);
          if (/继续编辑|编辑/.test(text) && text.length <= 12) {
            try { el.click(); return text; } catch (e) {}
          }
        }
      }
    }

    for (const el of all) {
      const text = textOf(el);
      if (/继续编辑|编辑/.test(text) && text.length <= 12) {
        try { el.click(); return text; } catch (e) {}
      }
    }

    return null;
    `,
    title
  );

  if (!continueEditText) {
    throw new Error('未找到草稿列表中的继续编辑按钮');
  }

  await driver.wait(async () => {
    const url = await driver.getCurrentUrl();
    if (/publish/.test(url)) return true;
    const text = await driver.executeScript(`return (document.body?.innerText || '').replace(/\s+/g, ' ').trim();`);
    return /发布文章|发文设置|预览并发布|共\s*\d+\s*字/.test(text || '');
  }, Math.min(timeoutMs, 15000));

  await driver.sleep(1200);
  await dismissTips(driver);
  if (useCoverImage) {
    await clickButtonByText(driver, '单图');
  } else {
    await clickButtonByText(driver, '无封面');
  }
  await driver.wait(async () => {
    const text = await driver.executeScript(`return (document.body?.innerText || '').replace(/\s+/g, ' ').trim();`);
    return !/草稿保存中|保存中/.test(text || '');
  }, 10000);

  const publishText = await clickButtonByText(driver, '预览并发布|立即发布|确认发布|提交发布');
  await driver.sleep(1200);
  await dismissTips(driver);
  await clickButtonByText(driver, '确认发布|立即发布|提交发布|发布');

  return publishText || 'draft-list-publish';
}

async function saveDraftArticleViaSelenium(options = {}) {
  const title = (options.title || '').trim();
  const content = (options.content || '').trim();
  const rawCookie = options.rawCookie || '';
  const openUrl = options.openUrl || 'https://mp.toutiao.com/profile_v4/graphic/publish';
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
  const headless = options.headless !== false;
  const autoSaveOnly = options.autoSaveOnly !== false;
  const publishMode = options.publish === true;
  const publishViaDraftFlow = options.publishViaDraftList === true;
  const chromeDebuggerAddress = (options.chromeDebuggerAddress || '').trim();
  const coverInfo = await prepareCoverImage(options);
  const useCoverImage = !!coverInfo.coverImagePath;

  if (!title) {
    throw new Error('缺少 title');
  }
  if (!content) {
    throw new Error('缺少 content');
  }

  const cookies = parseCookieString(rawCookie);
  if (!cookies.length) {
    throw new Error('缺少 rawCookie');
  }

  const chromeOptions = new chrome.Options();
  if (chromeDebuggerAddress) {
    chromeOptions.debuggerAddress(chromeDebuggerAddress);
  } else {
    if (headless) {
      chromeOptions.addArguments('--headless=new');
    }
    chromeOptions.addArguments('--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900');
  }

  const chromeBinary = process.env.CHROME_BIN || options.chromeBinary;
  if (chromeBinary) {
    chromeOptions.setChromeBinaryPath(chromeBinary);
  }

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(chromeOptions).build();

  try {
    let cookieSetCount = 0;
    const shouldSetCookies = cookies.length > 0 && options.forceSetCookies !== false;
    if (shouldSetCookies) {
      await driver.get('https://mp.toutiao.com/profile_v4/index');
      await waitForReady(driver, timeoutMs);

      for (const cookie of cookies) {
        try {
          await driver.manage().addCookie({
            name: cookie.name,
            value: cookie.value,
            path: '/'
          });
          cookieSetCount += 1;
        } catch (error) {
          try {
            await driver.manage().addCookie({
              name: cookie.name,
              value: cookie.value,
              domain: 'mp.toutiao.com',
              path: '/'
            });
            cookieSetCount += 1;
          } catch (error2) {
            // Ignore invalid cookies and continue with others.
          }
        }
      }
    }

    await driver.get(openUrl);
    await waitForReady(driver, timeoutMs);
    await waitForEditorPageReady(driver, timeoutMs);

    await driver.wait(until.elementLocated(By.css('body')), timeoutMs);
    await installNetworkCapture(driver);

    const result = await driver.executeScript(
      `
      const titleText = arguments[0];
      const contentText = arguments[1];
      const submitMode = arguments[2];
      const useCover = arguments[3] === true;

      const roots = [document];
      for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (iframe.contentDocument) roots.push(iframe.contentDocument);
        } catch (e) {}
      }

      const collectShadowRoots = (root) => {
        const list = [];
        const walk = (node) => {
          if (!node) return;
          if (node.shadowRoot) {
            list.push(node.shadowRoot);
            walk(node.shadowRoot);
          }
          const children = node.children || [];
          for (const child of children) walk(child);
        };
        walk(root);
        return list;
      };

      const expandedRoots = [];
      for (const root of roots) {
        expandedRoots.push(root);
        expandedRoots.push(...collectShadowRoots(root));
      }

      const find = (selectors) => {
        for (const root of expandedRoots) {
          for (const selector of selectors) {
            const el = root.querySelector(selector);
            if (el) return el;
          }
        }
        return null;
      };

      const setInput = (el, value) => {
        if (!el) return false;
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };

      const setEditor = (el, value) => {
        if (!el) return false;
        el.focus();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          return setInput(el, value);
        }
        el.innerHTML = '';
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };

      const titleEl = find([
        'input[aria-label*="标题"]',
        'input[placeholder*="标题"]',
        'textarea[placeholder*="标题"]',
        'input[class*="title"]',
        'textarea[class*="title"]',
        '.title-input input',
        'input[maxlength]'
      ]);

      const contentEl = find([
        '.ProseMirror[contenteditable="true"]',
        '.ProseMirror',
        '.ql-editor',
        '[data-slate-editor="true"]',
        '.editor [contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea[placeholder*="正文"]',
        'textarea[placeholder*="内容"]'
      ]);

      const titleSet = setInput(titleEl, titleText);
      const contentSet = setEditor(contentEl, contentText);

      const dismissBlockingTips = () => {
        const all = Array.from(document.querySelectorAll('button, [role="button"], .arco-btn, span, div'));
        for (const el of all) {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          if (/我知道了|知道了|关闭|稍后再说/.test(text) && text.length <= 10) {
            try { el.click(); } catch (e) {}
          }
        }
      };

      const chooseCoverStyle = (mode, withCover) => {
        if (mode !== 'publish') return;
        const labels = Array.from(document.querySelectorAll('label, span, div, button'));
        for (const el of labels) {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
          if (!withCover && text === '无封面') {
            try { el.click(); } catch (e) {}
            break;
          }
          if (withCover && text === '单图') {
            try { el.click(); } catch (e) {}
            break;
          }
        }
      };

      dismissBlockingTips();
      chooseCoverStyle(submitMode, useCover);

      const buttonCandidates = [];
      for (const root of expandedRoots) {
        buttonCandidates.push(...Array.from(root.querySelectorAll('button, [role="button"], .arco-btn, a, span, div')));
      }

      const clickActionButton = (mode) => {
        if (!mode || mode === 'none') return null;

        let fallback = null;
        for (const btn of buttonCandidates) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (!text) continue;
          if (text.length > 40) continue;
          if (/草稿保存中|保存中|发布中|提交中/.test(text)) continue;

          if (mode === 'publish') {
            if (/预览并发布|立即发布|确认发布|提交发布/.test(text)) {
              btn.click();
              return text;
            }
            if (/发布/.test(text) && !/发布文章|定时发布|发布设置|发布成功|发布中|发布得更多收益/.test(text) && !fallback) {
              fallback = btn;
            }
            continue;
          }

          if (mode === 'draft') {
            if (/保存草稿|存草稿|草稿箱/.test(text)) {
              btn.click();
              return text;
            }
            if (/保存/.test(text) && !/发布|提交|发送|保存中/.test(text) && !fallback) {
              fallback = btn;
            }
          }
        }

        if (fallback) {
          const text = (fallback.innerText || fallback.textContent || '').trim();
          fallback.click();
          return text;
        }

        return null;
      };

      const clickedButtonText = clickActionButton(submitMode);

      const visibleHints = buttonCandidates
        .map(btn => (btn.innerText || btn.textContent || '').trim())
        .filter(Boolean)
        .filter(t => /保存|草稿|发布|登录|验证|标题|内容|创作/.test(t))
        .slice(0, 20);

      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const pageHint = bodyText.slice(0, 500);

      const isLoginLike = /登录|扫码|验证码|手机号|密码|验证/.test(bodyText);
      const isEditorLike = /标题|正文|发布|草稿|创作/.test(bodyText);

      return {
        ok: titleSet && contentSet,
        titleSet,
        contentSet,
        clickedButtonText,
        saveMode: arguments[2] ? 'manual-save' : 'auto-save',
        visibleHints,
        pageHint,
        isLoginLike,
        isEditorLike,
        submitMode,
        message: submitMode === 'publish'
          ? (clickedButtonText ? '已触发发布按钮' : '未找到发布按钮')
          : (submitMode === 'draft'
            ? (clickedButtonText ? '已触发保存草稿' : '未找到保存草稿按钮')
            : '已填充内容，等待平台自动保存')
      };
      `,
      title,
      content,
      publishMode ? 'publish' : (!autoSaveOnly ? 'draft' : 'none'),
      useCoverImage
    );

    let normalizedResult = result;

    let coverUpload = null;
    if (useCoverImage) {
      try {
        coverUpload = await uploadCoverImage(driver, coverInfo.coverImagePath, timeoutMs);
        normalizedResult = {
          ...normalizedResult,
          coverUpload
        };
      } catch (error) {
        coverUpload = { attempted: true, uploaded: false, reason: error.message };
        normalizedResult = {
          ...normalizedResult,
          coverUpload
        };
      }
    }

    if (publishMode && publishViaDraftFlow) {
      try {
        // Stage 1: ensure current article is saved as draft first.
        await clickButtonByText(driver, '保存草稿|存草稿|保存');
        await driver.sleep(1800);
      } catch (error) {
        // Continue; some pages auto-save without explicit draft button.
      }

      try {
        const publishClickText = await publishViaDraftList(driver, title, timeoutMs, useCoverImage);
        normalizedResult = {
          ...normalizedResult,
          clickedButtonText: publishClickText,
          message: '已通过草稿列表回编并触发发布'
        };
      } catch (error) {
        normalizedResult = {
          ...normalizedResult,
          ok: false,
          message: `草稿列表发布阶段失败: ${error.message}`
        };
      }
    }

    // AIMedia-like behavior: after first publish click, try confirm publish in modal/footer.
    if (publishMode && normalizedResult && normalizedResult.clickedButtonText) {
      try {
        await driver.sleep(1200);
        await driver.executeScript(
          `
          const clickConfirm = () => {
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], .arco-btn, .byte-btn'));
            let clicked = null;

            for (const el of candidates) {
              const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
              if (!text) continue;
              if (text.length > 30) continue;
              if (/预览并发布|确认发布|立即发布|提交发布/.test(text)) {
                el.click();
                clicked = text;
                break;
              }
            }

            if (!clicked) {
              for (const el of candidates) {
                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                if (text.length > 30) continue;
                if (/我知道了|知道了|关闭|稍后再说/.test(text)) {
                  el.click();
                }
              }
            }

            if (!clicked) {
              for (const el of candidates) {
                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                if (text.length > 30) continue;
                if (/发布/.test(text) && !/发布文章|发布设置|定时发布|发布得更多收益|草稿/.test(text)) {
                  el.click();
                  clicked = text;
                  break;
                }
              }
            }

            return clicked;
          };

          return clickConfirm();
          `
        );
      } catch (error) {
        // Ignore confirm click failure and continue to feedback checks.
      }
    }

    // If editor still shows zero words, force real key input so editor model updates.
    if (publishMode) {
      try {
        const zeroWords = await driver.executeScript(
          `
          const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          return /共\s*0\s*字/.test(text);
          `
        );

        if (zeroWords) {
          const editorCandidates = await driver.findElements(
            By.css('.ProseMirror[contenteditable="true"], .ProseMirror, .ql-editor, [data-slate-editor="true"], .editor [contenteditable="true"], [contenteditable="true"], textarea[placeholder*="正文"], textarea[placeholder*="内容"]')
          );
          if (editorCandidates.length > 0) {
            const contentEl = editorCandidates[0];
            await contentEl.click();
            await contentEl.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
            for (const line of content.split('\n')) {
              await contentEl.sendKeys(line);
              await contentEl.sendKeys(Key.ENTER);
            }
            await driver.sleep(1000);
          }
        }
      } catch (error) {
        // Ignore forced typing failures and continue.
      }
    }

    if (publishMode) {
      try {
        await driver.sleep(1200);
        await dismissTips(driver);

        await driver.wait(async () => {
          const text = await driver.executeScript(
            `return (document.body?.innerText || '').replace(/\s+/g, ' ').trim();`
          );
          return !/草稿保存中|保存中/.test(text || '');
        }, 8000);

        if (useCoverImage) {
          await clickButtonByText(driver, '单图');
        }

        const publishText = await clickButtonByText(driver, '预览并发布|立即发布|确认发布|提交发布');
        if (publishText) {
          normalizedResult = {
            ...normalizedResult,
            clickedButtonText: publishText
          };
        }

        await driver.sleep(1000);
        await dismissTips(driver);
        await clickButtonByText(driver, '确认发布|立即发布|提交发布|发布');
      } catch (error) {
        // Ignore explicit publish click failures and continue feedback checks.
      }
    }

    // Some editor variants ignore synthetic DOM writes; fallback to real key input.
    if (!normalizedResult.titleSet || !normalizedResult.contentSet) {
      let titleSetByKeys = normalizedResult.titleSet;
      let contentSetByKeys = normalizedResult.contentSet;

      try {
        if (!titleSetByKeys) {
          const titleCandidates = await driver.findElements(
            By.css('input[aria-label*="标题"], input[placeholder*="标题"], textarea[placeholder*="标题"], input[class*="title"], textarea[class*="title"], .title-input input, input[maxlength]')
          );
          if (titleCandidates.length > 0) {
            const titleEl = titleCandidates[0];
            await titleEl.click();
            await titleEl.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE, title);
            titleSetByKeys = true;
          }
        }

        if (!contentSetByKeys) {
          const editorCandidates = await driver.findElements(
            By.css('.ProseMirror[contenteditable="true"], .ProseMirror, .ql-editor, [data-slate-editor="true"], .editor [contenteditable="true"], [contenteditable="true"], textarea[placeholder*="正文"], textarea[placeholder*="内容"]')
          );
          if (editorCandidates.length > 0) {
            const contentEl = editorCandidates[0];
            await contentEl.click();
            await contentEl.sendKeys(Key.chord(Key.CONTROL, 'a'), Key.BACK_SPACE);
            for (const line of content.split('\n')) {
              await contentEl.sendKeys(line);
              await contentEl.sendKeys(Key.ENTER);
            }
            contentSetByKeys = true;
          }
        }

        if (titleSetByKeys || contentSetByKeys) {
          await driver.sleep(1200);
          normalizedResult = {
            ...normalizedResult,
            titleSet: titleSetByKeys,
            contentSet: contentSetByKeys,
            ok: titleSetByKeys && contentSetByKeys,
            message: titleSetByKeys && contentSetByKeys
              ? (publishMode
                ? '已通过键盘输入填充内容，等待触发发布'
                : (autoSaveOnly ? '已通过键盘输入填充内容，等待平台自动保存' : normalizedResult.message))
              : normalizedResult.message
          };
        }
      } catch (error) {
        // Ignore fallback typing errors and keep original result.
      }
    }

    const currentUrl = await driver.getCurrentUrl();
    const pageTitle = await driver.getTitle();

    let finalResult = normalizedResult;
    if (!normalizedResult.ok && !autoSaveOnly && !publishMode) {
      try {
        await driver.actions().keyDown(Key.CONTROL).sendKeys('s').keyUp(Key.CONTROL).perform();
        await driver.sleep(1200);
        const shortcutResult = await driver.executeScript(
          `
          const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          const ok = /保存成功|已保存|草稿/.test(bodyText);
          return {
            ok,
            titleSet: false,
            contentSet: false,
            clickedButtonText: 'Ctrl+S',
            visibleHints: [],
            pageHint: bodyText.slice(0, 500),
            isLoginLike: /登录|扫码|验证码|手机号|密码|验证/.test(bodyText),
            isEditorLike: /标题|正文|发布|草稿|创作/.test(bodyText),
            message: ok ? '已触发 Ctrl+S，页面出现保存提示' : 'Ctrl+S 未检测到保存提示'
          };
          `
        );
        if (shortcutResult && shortcutResult.ok) {
          finalResult = shortcutResult;
        }
      } catch (error) {
        // Ignore Ctrl+S fallback failures.
      }
    }

    if (finalResult.ok) {
      try {
        let sawSaving = false;
        let sawSaved = false;
        let sawPublishing = false;
        let sawPublished = false;

        await driver.wait(async () => {
          const saveState = await driver.executeScript(
            `
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            const saving = /草稿保存中|保存中/.test(text);
            const saved = /草稿已保存|已保存到草稿|保存成功|保存至草稿/.test(text);
            const publishing = /发布中|提交中|发布任务处理中/.test(text);
            const published = /发布成功|提交成功|审核中|已发布/.test(text);
            const failed = /保存失败/.test(text);
            const publishFailed = /发布失败|提交失败/.test(text);
            return { saving, saved, failed, publishing, published, publishFailed };
            `
          );

          if (saveState && saveState.saving) sawSaving = true;
          if (saveState && saveState.saved) sawSaved = true;
          if (saveState && saveState.publishing) sawPublishing = true;
          if (saveState && saveState.published) sawPublished = true;
          if (saveState && saveState.failed) return true;
          if (saveState && saveState.publishFailed) return true;

          if (publishMode) {
            if (sawPublished) return true;
            if (sawPublishing && !saveState.publishing) return true;
            return false;
          }

          if (autoSaveOnly) {
            if (sawSaved) return true;
            if (sawSaving && !saveState.saving) return true;
            return false;
          }

          return !!(saveState.saved || !saveState.saving);
        }, Math.min(timeoutMs, 20000));
      } catch (error) {
        if (publishMode) {
          finalResult = {
            ...finalResult,
            ok: false,
            message: '未观测到发布完成提示'
          };
        } else if (autoSaveOnly) {
          finalResult = {
            ...finalResult,
            ok: false,
            message: '未观测到自动保存完成'
          };
        }
      }

      // Give remote save requests a little extra time before closing browser.
      await driver.sleep(3000);

      try {
        const saveFeedback = await driver.executeScript(
          `
          const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
          return {
            failed: /保存失败/.test(text),
            saved: /草稿已保存|已保存到草稿|保存成功|保存至草稿/.test(text),
            text: text.slice(0, 800)
          };
          `
        );

        if (publishMode) {
          const publishFail = /发布失败|提交失败/.test(saveFeedback ? saveFeedback.text : '');
          const publishSuccess = /发布成功|提交成功|审核中|已发布/.test(saveFeedback ? saveFeedback.text : '');

          if (publishFail) {
            finalResult = {
              ...finalResult,
              ok: false,
              message: '发布失败（页面提示）',
              saveFeedback: saveFeedback.text
            };
          } else if (publishSuccess) {
            finalResult = {
              ...finalResult,
              ok: true,
              message: '发布成功（页面提示）',
              saveFeedback: saveFeedback.text
            };
          } else {
            finalResult = {
              ...finalResult,
              ok: false,
              message: '未检测到明确发布结果提示',
              saveFeedback: saveFeedback ? saveFeedback.text : null
            };
          }
        } else if (saveFeedback && saveFeedback.failed) {
          finalResult = {
            ...finalResult,
            ok: false,
            message: '草稿保存失败（页面提示）',
            saveFeedback: saveFeedback.text
          };
        } else if (saveFeedback && saveFeedback.saved) {
          finalResult = {
            ...finalResult,
            message: '草稿保存成功（页面提示）',
            saveFeedback: saveFeedback.text
          };
        } else if (autoSaveOnly) {
          finalResult = {
            ...finalResult,
            ok: false,
            message: '未检测到自动保存成功提示',
            saveFeedback: saveFeedback ? saveFeedback.text : null
          };
        }
      } catch (error) {
        // Ignore feedback parsing failures.
      }
    }

    let publishNetworkSignals = [];
    if (publishMode) {
      try {
        await driver.sleep(1200);
        const captured = await readNetworkCapture(driver);
        publishNetworkSignals = buildPublishSignals(captured);
        finalResult = applyPublishResultFromSignals(finalResult, publishNetworkSignals);
      } catch (error) {
        // Ignore network capture parsing failures.
      }
    }

    if (publishNetworkSignals.length > 0) {
      finalResult = {
        ...finalResult,
        publishNetworkSignals
      };
    }

    let debug = null;
    if (!finalResult.ok) {
      const ts = Date.now();
      const screenshotPath = `/tmp/toutiao-selenium-draft-${ts}.png`;
      const pageSourcePath = `/tmp/toutiao-selenium-draft-${ts}.html`;

      try {
        const screenshot = await driver.takeScreenshot();
        fs.writeFileSync(screenshotPath, screenshot, 'base64');
      } catch (error) {
        // Ignore debug screenshot failure.
      }

      try {
        const source = await driver.getPageSource();
        fs.writeFileSync(pageSourcePath, source || '', 'utf8');
      } catch (error) {
        // Ignore debug source failure.
      }

      debug = {
        screenshotPath,
        pageSourcePath,
        cwd: process.cwd(),
        chromeBinary: process.env.CHROME_BIN || options.chromeBinary || null
      };
    }

    return {
      success: !!finalResult.ok,
      mode: 'selenium-chrome',
      submitMode: publishMode ? 'publish' : (autoSaveOnly ? 'auto-save' : 'manual-save'),
      openUrl,
      title,
      cookieSetCount,
      chromeDebuggerAddress: chromeDebuggerAddress || null,
      currentUrl,
      pageTitle,
      cover: {
        used: useCoverImage,
        source: coverInfo.coverImageSource,
        imageUrl: coverInfo.coverImageUrl,
        imagePath: coverInfo.coverImagePath
      },
      debug,
      result: finalResult
    };
  } finally {
    if (coverInfo && coverInfo.tempDownloaded && coverInfo.coverImagePath) {
      try {
        fs.unlinkSync(coverInfo.coverImagePath);
      } catch (error) {
        // Ignore cleanup failures.
      }
    }
    await driver.quit();
  }
}

module.exports = {
  saveDraftArticleViaSelenium
};
