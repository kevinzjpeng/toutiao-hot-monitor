const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const baseConfig = require('../config.json');

const LOCAL_MP_CONFIG_PATH = path.join(__dirname, '../mp-request.local.json');
const DEFAULT_MP_URL = 'https://mp.toutiao.com/monitor_browser/collect/batch/?biz_id=toutiao_mp';
const DEFAULT_PUBLISH_URL = 'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231';
const DEFAULT_WEITOUTIAO_PUBLISH_URL = 'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=weitoutiao&aid=1231';

function normalizePublishType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'article';
  if (['weitoutiao', 'micro', 'micro-post', 'wtt'].includes(raw)) {
    return 'weitoutiao';
  }
  return 'article';
}

function resolvePublishUrl(runtimeOptions = {}, parsedHeaders = {}) {
  const explicitRuntimeUrl = runtimeOptions.runtimeUrl || runtimeOptions.publishUrl || runtimeOptions.explicitPublishUrl;
  if (explicitRuntimeUrl && String(explicitRuntimeUrl).trim()) {
    return String(explicitRuntimeUrl).trim();
  }

  if (parsedHeaders[':scheme'] && parsedHeaders[':authority'] && parsedHeaders[':path']) {
    return buildUrlFromPseudoHeaders(parsedHeaders, DEFAULT_PUBLISH_URL);
  }

  const publishType = normalizePublishType(runtimeOptions.publishType);
  if (publishType === 'weitoutiao') {
    return DEFAULT_WEITOUTIAO_PUBLISH_URL;
  }
  return DEFAULT_PUBLISH_URL;
}

function parseRawHeaderPairs(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {};
  }

  const lines = rawText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const headers = {};

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];

    // Support one-line format: "header-name: value"
    const oneLineMatch = current.match(/^([^\s][^:]*):\s*(.*)$/);
    if (oneLineMatch && !current.startsWith(':')) {
      const key = oneLineMatch[1].trim();
      const value = oneLineMatch[2].trim();
      if (key && value) {
        headers[key.toLowerCase()] = value;
      }
      continue;
    }

    // Support two-line format copied from DevTools: key on one line, value on next line
    const key = current;
    const value = lines[i + 1];

    if (!value) {
      continue;
    }

    headers[key.toLowerCase()] = value;
    i += 1;
  }

  return headers;
}

function buildUrlFromPseudoHeaders(headers, fallbackUrl) {
  if (headers[':scheme'] && headers[':authority'] && headers[':path']) {
    return `${headers[':scheme']}://${headers[':authority']}${headers[':path']}`;
  }
  return fallbackUrl || DEFAULT_MP_URL;
}

function toRequestHeaders(headers, rawCookie) {
  const blockedHeaders = new Set([
    ':authority',
    ':method',
    ':path',
    ':scheme',
    'content-length',
    'host'
  ]);

  const result = {};

  Object.entries(headers).forEach(([key, value]) => {
    if (blockedHeaders.has(key)) {
      return;
    }

    if (typeof value !== 'string' || !value.trim()) {
      return;
    }

    result[key] = value.trim();
  });

  if (rawCookie && typeof rawCookie === 'string' && rawCookie.trim()) {
    result.cookie = rawCookie.trim();
  } else if (headers.cookie) {
    result.cookie = headers.cookie;
  }

  return result;
}

function loadLocalMpConfig() {
  try {
    if (!fs.existsSync(LOCAL_MP_CONFIG_PATH)) {
      return {};
    }
    const content = fs.readFileSync(LOCAL_MP_CONFIG_PATH, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.warn('⚠️ 读取 mp-request.local.json 失败，将只使用 config.json:', error.message);
    return {};
  }
}

function resolveMpRequestOptions(runtimeOptions = {}) {
  const configMp = baseConfig.mpRequest || {};
  const localMp = loadLocalMpConfig();

  // Priority: runtime > local file > config.json
  return {
    mode: 'agent-browser',
    fallbackToHttp: true,
    ...configMp,
    ...localMp,
    ...runtimeOptions
  };
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
      const index = part.indexOf('=');
      if (index <= 0) {
        return null;
      }
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim()
      };
    })
    .filter(Boolean);
}

function toBrowserFetchHeaders(headers) {
  const blocked = new Set([
    'cookie',
    'user-agent',
    'accept-encoding',
    'content-length',
    'host',
    'origin',
    'referer',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'priority'
  ]);

  const browserHeaders = {};

  Object.entries(headers).forEach(([key, value]) => {
    if (!blocked.has(key) && typeof value === 'string' && value.trim()) {
      browserHeaders[key] = value;
    }
  });

  return browserHeaders;
}

async function sendViaHttp(requestUrl, requestHeaders, requestBody, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;

  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: requestUrl,
    data,
    mode: 'http'
  };
}

function buildHtmlParagraphContent(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return '';
  }

  return lines
    .map((line, idx) => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<p data-track="${idx + 1}">${escaped}</p>`;
    })
    .join('');
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, '')
    .trim();
}

function safeParseJsonObject(value, fallback = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall back to provided fallback value.
  }

  return fallback;
}

function resolveTemplateBody(runtimeOptions = {}) {
  if (typeof runtimeOptions.rawBodyTemplate === 'string' && runtimeOptions.rawBodyTemplate.trim()) {
    return {
      body: runtimeOptions.rawBodyTemplate.trim(),
      source: 'rawBodyTemplate'
    };
  }

  if (typeof runtimeOptions.rawBodyTemplatePath === 'string' && runtimeOptions.rawBodyTemplatePath.trim()) {
    const rawPath = runtimeOptions.rawBodyTemplatePath.trim();
    const fullPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.join(__dirname, '..', rawPath);
    const text = fs.readFileSync(fullPath, 'utf8').trim();

    if (text.startsWith('{')) {
      const parsed = JSON.parse(text);
      const fromJson = (parsed.rawBodyTemplate || parsed.rawBody || '').trim();
      if (fromJson) {
        return {
          body: fromJson,
          source: `rawBodyTemplatePath:${rawPath}`
        };
      }
    }

    return {
      body: text,
      source: `rawBodyTemplatePath:${rawPath}`
    };
  }

  if (typeof runtimeOptions.rawBody === 'string' && runtimeOptions.rawBody.trim()) {
    return {
      body: runtimeOptions.rawBody.trim(),
      source: 'rawBody'
    };
  }

  return null;
}

function normalizePublishBodyFromTemplate(runtimeOptions = {}) {
  const template = resolveTemplateBody(runtimeOptions);
  if (!template) {
    return null;
  }

  const publishType = normalizePublishType(runtimeOptions.publishType);
  const title = (runtimeOptions.title || '').trim();
  const htmlContent = (runtimeOptions.htmlContent || '').trim() || buildHtmlParagraphContent(runtimeOptions.content || '');
  const fallbackTitle = !title && publishType === 'weitoutiao'
    ? stripHtmlToText(htmlContent).slice(0, 30)
    : '';
  const effectiveTitle = title || fallbackTitle;
  const form = new URLSearchParams(template.body);
  const changes = [];

  const setValue = (key, value) => {
    if (value === undefined || value === null) {
      return;
    }

    const nextValue = String(value);
    const prevValue = form.get(key);

    if (prevValue !== nextValue) {
      form.set(key, nextValue);
      changes.push(key);
    }
  };

  if (effectiveTitle) {
    setValue('title', effectiveTitle);
  }

  if (htmlContent) {
    setValue('content', htmlContent);
  }

  if ((title || htmlContent) && runtimeOptions.refreshTitleId !== false) {
    setValue('title_id', `${Date.now()}_${Math.floor(Math.random() * 1e15)}`);
  }

  if (runtimeOptions.searchCreationInfo && typeof runtimeOptions.searchCreationInfo === 'object') {
    setValue('search_creation_info', JSON.stringify(runtimeOptions.searchCreationInfo));
  }

  const extra = safeParseJsonObject(form.get('extra'), {});
  if (htmlContent) {
    extra.content_word_cnt = stripHtmlToText(htmlContent).length;
  }
  if (runtimeOptions.extraPatch && typeof runtimeOptions.extraPatch === 'object') {
    Object.assign(extra, runtimeOptions.extraPatch);
  }
  if (Object.keys(extra).length) {
    setValue('extra', JSON.stringify(extra));
  }

  if (runtimeOptions.bodyPatches && typeof runtimeOptions.bodyPatches === 'object') {
    Object.entries(runtimeOptions.bodyPatches).forEach(([key, value]) => {
      if (typeof value === 'string') {
        setValue(key, value);
      } else {
        setValue(key, JSON.stringify(value));
      }
    });
  }

  const publishOptionsPatch = ensurePublishOptionsEnabled(form, runtimeOptions);
  changes.push(...publishOptionsPatch.changedKeys);

  return {
    rawBody: form.toString(),
    normalization: {
      mode: 'template',
      source: template.source,
      publishType,
      changedKeys: Array.from(new Set(changes)),
      publishOptions: publishOptionsPatch
    }
  };
}

function buildPublishFormBody(runtimeOptions = {}) {
  const normalized = normalizePublishBodyFromTemplate(runtimeOptions);
  if (normalized) {
    return normalized;
  }

  const publishType = normalizePublishType(runtimeOptions.publishType);
  const title = (runtimeOptions.title || '').trim();
  const content = (runtimeOptions.content || '').trim();
  const fallbackTitle = !title && publishType === 'weitoutiao'
    ? content.slice(0, 30)
    : '';
  const effectiveTitle = title || fallbackTitle;

  if (!effectiveTitle || !content) {
    throw new Error('publish 请求缺少 rawBody，且未提供 title/content 用于构造表单');
  }

  const extra = {
    content_source: 100000000402,
    content_word_cnt: content.replace(/\s+/g, '').length,
    is_multi_title: 0,
    sub_titles: [],
    gd_ext: {
      entrance: '',
      from_page: 'publisher_mp',
      enter_from: 'PC',
      device_platform: 'mp',
      is_message: 0
    },
    tuwen_wtt_transfer_switch: '1'
  };

  const htmlContent = buildHtmlParagraphContent(content);

  const form = new URLSearchParams();
  form.set('source', String(runtimeOptions.source || 29));
  form.set('extra', JSON.stringify(extra));
  form.set('content', htmlContent);
  form.set('title', effectiveTitle);
  form.set('search_creation_info', JSON.stringify(runtimeOptions.searchCreationInfo || {}));
  const publishOptionsPatch = ensurePublishOptionsEnabled(form, runtimeOptions);

  return {
    rawBody: form.toString(),
    normalization: {
      mode: 'basic',
      source: 'generated',
      publishType,
      publishOptions: publishOptionsPatch
    }
  };
}

function ensurePublishOptionsEnabled(form, runtimeOptions = {}) {
  if (!form || typeof form.get !== 'function' || typeof form.set !== 'function') {
    return { enabled: false, changedKeys: [], skipped: 'invalid-form' };
  }

  if (runtimeOptions.enableAdvertisement === false && runtimeOptions.enableToutiaoFirstPublish === false) {
    return { enabled: false, changedKeys: [], skipped: 'disabled-by-option' };
  }

  const changedKeys = [];
  const setValue = (key, value) => {
    const nextValue = String(value);
    const prevValue = form.get(key);
    if (prevValue !== nextValue) {
      form.set(key, nextValue);
      changedKeys.push(key);
    }
  };

  if (runtimeOptions.enableAdvertisement !== false) {
    setValue('ad_status', '1');
    setValue('ad_enable', '1');
    setValue('advertisement_enable', '1');
    setValue('monetization_enable', '1');
  }

  if (runtimeOptions.enableToutiaoFirstPublish !== false) {
    setValue('toutiao_first_publish', '1');
    setValue('is_toutiao_first_publish', '1');
    setValue('first_publish_toutiao', '1');
    setValue('tt_first_publish', '1');
  }

  let draftFormData = {};
  const rawDraftFormData = form.get('draft_form_data');
  if (rawDraftFormData) {
    try {
      draftFormData = JSON.parse(rawDraftFormData);
    } catch (error) {
      draftFormData = {};
    }
  }

  const draftAssignments = {};
  if (runtimeOptions.enableAdvertisement !== false) {
    Object.assign(draftAssignments, {
      ad_status: 1,
      adStatus: 1,
      ad_enable: 1,
      adEnable: 1,
      advertisement_enable: 1,
      advertisementEnable: 1,
      monetization_enable: 1,
      monetizationEnable: 1,
      can_insert_ad: 1,
      canInsertAd: 1,
      is_open_ad: 1,
      isOpenAd: 1
    });
  }

  if (runtimeOptions.enableToutiaoFirstPublish !== false) {
    Object.assign(draftAssignments, {
      toutiao_first_publish: 1,
      toutiaoFirstPublish: 1,
      is_toutiao_first_publish: 1,
      isToutiaoFirstPublish: 1,
      first_publish_toutiao: 1,
      firstPublishToutiao: 1,
      tt_first_publish: 1,
      ttFirstPublish: 1
    });
  }

  let draftChanged = false;
  Object.entries(draftAssignments).forEach(([key, value]) => {
    if (draftFormData[key] !== value) {
      draftFormData[key] = value;
      draftChanged = true;
    }
  });

  if (draftChanged || !rawDraftFormData) {
    form.set('draft_form_data', JSON.stringify(draftFormData));
    changedKeys.push('draft_form_data');
  }

  return {
    enabled: true,
    changedKeys: Array.from(new Set(changedKeys))
  };
}

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

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const url = resolveUrl(pageUrl, match[1]);
      if (url) return url;
    }
  }

  return null;
}

function guessImageMimeType(contentType, imageUrl) {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.startsWith('image/')) {
    return normalized.split(';')[0].trim();
  }

  const pathname = (() => {
    try {
      return new URL(imageUrl).pathname.toLowerCase();
    } catch (error) {
      return '';
    }
  })();

  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

function guessImageFilename(imageUrl, mimeType) {
  const extMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
  };

  const fromUrl = (() => {
    try {
      const pathname = new URL(imageUrl).pathname || '';
      const name = pathname.split('/').filter(Boolean).pop() || '';
      if (/\.[a-zA-Z0-9]{2,5}$/.test(name)) {
        return name;
      }
      return '';
    } catch (error) {
      return '';
    }
  })();

  if (fromUrl) {
    return fromUrl;
  }

  const ext = extMap[mimeType] || 'jpg';
  return `cover-${Date.now()}.${ext}`;
}

async function prepareCoverImageData(runtimeOptions = {}) {
  const explicitPath = (runtimeOptions.coverImagePath || '').trim();
  const explicitUrl = (runtimeOptions.coverImageUrl || '').trim();
  const blogUrl = (runtimeOptions.blogUrl || runtimeOptions.sourceUrl || runtimeOptions.articleUrl || '').trim();

  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`coverImagePath 不存在: ${explicitPath}`);
    }

    const fileBuffer = fs.readFileSync(explicitPath);
    const mimeType = guessImageMimeType('', explicitPath);
    return {
      sourceType: 'local-path',
      imageUrl: null,
      mimeType,
      filename: path.basename(explicitPath) || guessImageFilename(explicitPath, mimeType),
      buffer: fileBuffer
    };
  }

  let imageUrl = explicitUrl;
  let sourceType = explicitUrl ? 'cover-image-url' : null;

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
    sourceType = 'blog-featured-image';
  }

  if (!imageUrl) {
    return null;
  }

  const imageResp = await fetch(imageUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      referer: blogUrl || 'https://mp.toutiao.com/profile_v4/graphic/publish'
    }
  });

  if (!imageResp.ok) {
    throw new Error(`封面图片下载失败: ${imageResp.status}`);
  }

  const contentType = imageResp.headers.get('content-type') || '';
  const mimeType = guessImageMimeType(contentType, imageUrl);
  if (!mimeType.startsWith('image/')) {
    throw new Error(`封面资源不是图片: ${contentType}`);
  }

  const buffer = Buffer.from(await imageResp.arrayBuffer());
  return {
    sourceType,
    imageUrl,
    mimeType,
    filename: guessImageFilename(imageUrl, mimeType),
    buffer
  };
}

function pickHeader(sourceHeaders, key) {
  if (!sourceHeaders || typeof sourceHeaders !== 'object') {
    return null;
  }

  const value = sourceHeaders[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return null;
}

function buildSpiceUploadHeaders(requestHeaders) {
  const out = {
    accept: 'application/json, text/plain, */*'
  };

  const passThrough = [
    'cookie',
    'tt-anti-token',
    'x-secsdk-csrf-token',
    'x-tt-env',
    'x-tt-logid',
    'user-agent',
    'origin',
    'referer'
  ];

  passThrough.forEach((key) => {
    const value = pickHeader(requestHeaders, key);
    if (value) {
      out[key] = value;
    }
  });

  if (!out.origin) {
    out.origin = 'https://mp.toutiao.com';
  }
  if (!out.referer) {
    out.referer = 'https://mp.toutiao.com/profile_v4/graphic/publish';
  }

  return out;
}

function buildJsonApiHeaders(requestHeaders) {
  const out = buildSpiceUploadHeaders(requestHeaders);
  out['content-type'] = 'application/json';
  return out;
}

function buildOpenImageCandidates(spiceImageData) {
  const uri = spiceImageData.image_uri || spiceImageData.uri || spiceImageData.web_uri || '';
  const imageUrl = spiceImageData.image_url || spiceImageData.url || spiceImageData.cover_url || '';
  const coverUrl = spiceImageData.cover_url || imageUrl;

  const normalized = {
    image_uri: uri,
    image_url: imageUrl,
    origin_image_uri: spiceImageData.origin_image_uri || uri,
    origin_image_url: spiceImageData.origin_image_url || imageUrl,
    cover_url: coverUrl,
    image_width: Number(spiceImageData.image_width || spiceImageData.width || 0),
    image_height: Number(spiceImageData.image_height || spiceImageData.height || 0),
    image_size: Number(spiceImageData.image_size || 0),
    image_format: spiceImageData.image_format || '',
    image_mime_type: spiceImageData.image_mime_type || '',
    image_type: Number(spiceImageData.image_type || 1)
  };

  const legacy = {
    uri,
    url: coverUrl,
    origin_uri: spiceImageData.origin_image_uri || uri,
    origin_url: imageUrl,
    web_uri: spiceImageData.web_uri || uri,
    web_url: spiceImageData.web_url || coverUrl,
    width: Number(spiceImageData.image_width || spiceImageData.width || 0),
    height: Number(spiceImageData.image_height || spiceImageData.height || 0)
  };

  return [
    { name: 'raw-spice-data', body: { images: [spiceImageData] } },
    { name: 'normalized-image-fields', body: { images: [normalized] } },
    { name: 'legacy-cover-fields', body: { images: [legacy] } },
    { name: 'stringified-images-normalized', body: { images: JSON.stringify([normalized]) } }
  ];
}

async function tryRegisterOpenImageMaterial(spiceImageData, requestHeaders, timeoutMs) {
  const urls = [
    'https://mp.toutiao.com/mp/agw/article_material/open_image/add',
    'https://mp.toutiao.com/mp/agw/article_material/open_image/add?aid=1231'
  ];

  const candidates = buildOpenImageCandidates(spiceImageData);
  const attempts = [];

  for (const url of urls) {
    for (const candidate of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: buildJsonApiHeaders(requestHeaders),
          body: JSON.stringify(candidate.body),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        attempts.push({
          url,
          shape: candidate.name,
          networkError: error.message
        });
        continue;
      }

      clearTimeout(timer);

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = { raw: text };
      }

      const code = data && (data.code ?? data.err_no);
      const attempt = {
        url,
        shape: candidate.name,
        status: response.status,
        code,
        ok: response.ok && Number(code) === 0,
        message: data && (data.message || data.reason || null)
      };

      attempts.push(attempt);

      if (attempt.ok) {
        return {
          success: true,
          usedUrl: url,
          usedShape: candidate.name,
          response: data,
          attempts
        };
      }
    }
  }

  return {
    success: false,
    attempts
  };
}

function toCoverPayloadFromSpiceData(spiceData) {
  if (!spiceData || typeof spiceData !== 'object') {
    throw new Error('spice/image 返回的图片数据为空');
  }

  const uri = spiceData.image_uri || spiceData.uri || spiceData.web_uri || '';
  const url = spiceData.cover_url || spiceData.image_url || spiceData.url || '';

  if (!uri || !url) {
    throw new Error('spice/image 返回缺少 uri/url，无法构造封面');
  }

  const width = Number(spiceData.width || spiceData.web_width || 0);
  const height = Number(spiceData.height || spiceData.web_height || 0);

  const payload = {
    id: '',
    uri,
    url,
    origin_uri: uri,
    origin_url: spiceData.image_url || url,
    web_uri: spiceData.web_uri || uri,
    web_url: spiceData.web_url || url
  };

  if (width > 0) {
    payload.width = width;
  }
  if (height > 0) {
    payload.height = height;
  }

  return payload;
}

function injectCoverIntoRawBody(rawBody, coverPayload) {
  const form = new URLSearchParams(String(rawBody || ''));

  form.set('pgc_feed_covers', JSON.stringify([coverPayload]));

  let draftFormData = {};
  const rawDraftFormData = form.get('draft_form_data');
  if (rawDraftFormData) {
    try {
      draftFormData = JSON.parse(rawDraftFormData);
    } catch (error) {
      draftFormData = {};
    }
  }

  draftFormData.coverType = 1;
  form.set('draft_form_data', JSON.stringify(draftFormData));

  return form.toString();
}

function getFormField(rawBody, field) {
  const form = new URLSearchParams(String(rawBody || ''));
  const value = form.get(field);
  return value === null ? '' : String(value);
}

function setFormField(rawBody, field, value) {
  const form = new URLSearchParams(String(rawBody || ''));
  form.set(field, String(value));
  return form.toString();
}

function applySubmitStyleFallback(rawBody) {
  let nextBody = String(rawBody || '');
  nextBody = setFormField(nextBody, 'save', '1');
  nextBody = setFormField(nextBody, 'pgc_id', '');
  return nextBody;
}

async function sendPublishReplay(requestUrl, requestHeaders, requestBody, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    data = { raw: text };
  }

  const code = data && (data.code ?? data.err_no);
  return {
    response,
    data,
    code: Number(code),
    saveValue: getFormField(requestBody, 'save')
  };
}

async function uploadCoverAndInject(rawBody, requestHeaders, runtimeOptions, timeoutMs) {
  const coverImageData = await prepareCoverImageData(runtimeOptions);
  if (!coverImageData) {
    return {
      rawBody,
      cover: {
        used: false,
        reason: 'no-cover-options'
      }
    };
  }

  const uploadUrl = 'https://mp.toutiao.com/spice/image?upload_source=20020003&need_cover_url=1&need_enhance=true&aid=1231&device_platform=web&scene=paste';

  const form = new FormData();
  form.append(
    'image',
    new Blob([coverImageData.buffer], { type: coverImageData.mimeType }),
    coverImageData.filename
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let uploadResponse;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: buildSpiceUploadHeaders(requestHeaders),
      body: form,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const uploadText = await uploadResponse.text();
  let uploadData;
  try {
    uploadData = JSON.parse(uploadText);
  } catch (error) {
    uploadData = { raw: uploadText };
  }

  const uploadCode = uploadData && (uploadData.code ?? uploadData.err_no);
  if (!uploadResponse.ok || Number(uploadCode) !== 0) {
    return {
      rawBody,
      cover: {
        used: false,
        reason: 'spice-upload-failed',
        status: uploadResponse.status,
        code: uploadCode,
        response: uploadData,
        sourceType: coverImageData.sourceType,
        sourceUrl: coverImageData.imageUrl || null
      }
    };
  }

  const spiceImageData = uploadData.data || uploadData;
  const materialRegistration = await tryRegisterOpenImageMaterial(spiceImageData, requestHeaders, timeoutMs);
  const coverPayload = toCoverPayloadFromSpiceData(spiceImageData);
  const patchedRawBody = injectCoverIntoRawBody(rawBody, coverPayload);

  return {
    rawBody: patchedRawBody,
    cover: {
      used: true,
      sourceType: coverImageData.sourceType,
      sourceUrl: coverImageData.imageUrl || null,
      filename: coverImageData.filename,
      mimeType: coverImageData.mimeType,
      uploadCode,
      uploadStatus: uploadResponse.status,
      materialRegistration,
      coverPayload,
      spiceImageData
    }
  };
}

async function publishDraftViaHttp(runtimeOptions = {}) {
  const options = resolveMpRequestOptions(runtimeOptions);
  const parsedHeaders = parseRawHeaderPairs(options.rawHeaders || '');
  const publishType = normalizePublishType(options.publishType);

  const requestUrl = resolvePublishUrl(runtimeOptions, parsedHeaders);

  const requestHeaders = toRequestHeaders(parsedHeaders, options.rawCookie);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;

  if (!requestHeaders.cookie) {
    throw new Error('缺少 Cookie。请在 rawCookie 或 rawHeaders 中提供 cookie。');
  }

  if (!requestHeaders['content-type']) {
    requestHeaders['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  }
  if (!requestHeaders.accept) {
    requestHeaders.accept = 'application/json, text/plain, */*';
  }

  const bodyBuildResult = buildPublishFormBody(options);
  const initialBody = bodyBuildResult.rawBody;
  const shouldTryCover = Boolean(
    (options.coverImagePath && String(options.coverImagePath).trim()) ||
    (options.coverImageUrl && String(options.coverImageUrl).trim()) ||
    (options.blogUrl && String(options.blogUrl).trim()) ||
    (options.sourceUrl && String(options.sourceUrl).trim()) ||
    (options.articleUrl && String(options.articleUrl).trim())
  );

  let requestBody = initialBody;
  let coverResult = {
    used: false,
    reason: 'no-cover-options'
  };

  if (shouldTryCover) {
    try {
      const coverInjection = await uploadCoverAndInject(initialBody, requestHeaders, options, timeoutMs);
      requestBody = coverInjection.rawBody;
      coverResult = coverInjection.cover;
    } catch (error) {
      coverResult = {
        used: false,
        reason: 'cover-injection-error',
        error: error.message
      };
    }
  }

  const retry7050WithSaveSubmit = options.retry7050WithSaveSubmit !== false;
  const retryWithClearedPgcId = options.retryWithClearedPgcId !== false;
  const attempts = [];

  const firstTry = await sendPublishReplay(requestUrl, requestHeaders, requestBody, timeoutMs);
  attempts.push({
    index: 1,
    save: firstTry.saveValue,
    status: firstTry.response.status,
    code: firstTry.code,
    message: firstTry.data && (firstTry.data.message || firstTry.data.reason || null)
  });

  let finalTry = firstTry;
  if (retry7050WithSaveSubmit && firstTry.code === 7050 && String(firstTry.saveValue) !== '1') {
    const retryBody = setFormField(requestBody, 'save', '1');
    const secondTry = await sendPublishReplay(requestUrl, requestHeaders, retryBody, timeoutMs);
    attempts.push({
      index: 2,
      save: secondTry.saveValue,
      status: secondTry.response.status,
      code: secondTry.code,
      message: secondTry.data && (secondTry.data.message || secondTry.data.reason || null)
    });

    finalTry = secondTry;
    requestBody = retryBody;
  }

  const staleStateCodes = new Set([4012, 4013, 5009, 7050]);
  const currentPgcId = getFormField(requestBody, 'pgc_id');
  const shouldRetryWithClearedPgcId =
    retryWithClearedPgcId &&
    Number(finalTry.code) !== 0 &&
    staleStateCodes.has(Number(finalTry.code)) &&
    Boolean(String(currentPgcId || '').trim());

  if (shouldRetryWithClearedPgcId) {
    const fallbackBody = applySubmitStyleFallback(requestBody);
    const fallbackTry = await sendPublishReplay(requestUrl, requestHeaders, fallbackBody, timeoutMs);
    attempts.push({
      index: attempts.length + 1,
      save: fallbackTry.saveValue,
      status: fallbackTry.response.status,
      code: fallbackTry.code,
      message: fallbackTry.data && (fallbackTry.data.message || fallbackTry.data.reason || null),
      strategy: 'clear-pgc-id-and-submit'
    });

    finalTry = fallbackTry;
    requestBody = fallbackBody;
  }

  const response = finalTry.response;
  const data = finalTry.data;
  const code = finalTry.code;
  const isSuccessCode = Number(code) === 0;

  return {
    ok: response.ok && isSuccessCode,
    status: response.status,
    statusText: response.statusText,
    mode: 'http-replay',
    publishType,
    url: requestUrl,
    code,
    attempts,
    cover: coverResult,
    bodyNormalization: bodyBuildResult.normalization,
    message: data && (data.message || data.reason) ? (data.message || data.reason) : null,
    data
  };
}

async function publishWeitoutiaoViaHttp(runtimeOptions = {}) {
  return publishDraftViaHttp({
    ...runtimeOptions,
    publishType: 'weitoutiao'
  });
}

async function sendViaAgentBrowser(requestUrl, requestHeaders, requestBody, options) {
  const cookiePairs = parseCookieString(requestHeaders.cookie || '');
  const openUrl = requestHeaders.referer || 'https://mp.toutiao.com/profile_v4/index';
  const browserHeaders = toBrowserFetchHeaders(requestHeaders);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;

  if (cookiePairs.length === 0) {
    throw new Error('agent-browser 模式下需要有效 Cookie。');
  }

  try {
    cookiePairs.forEach(({ name, value }) => {
      execFileSync('agent-browser', ['cookies', 'set', name, value], {
        stdio: 'pipe',
        timeout: 5000
      });
    });

    execFileSync('agent-browser', ['open', openUrl], {
      stdio: 'pipe',
      timeout: timeoutMs
    });

    const bodyText = JSON.stringify(requestBody || {});
    const script = `(() => fetch(${JSON.stringify(requestUrl)}, { method: 'POST', credentials: 'include', headers: ${JSON.stringify(browserHeaders)}, body: ${JSON.stringify(bodyText)} }).then(async (res) => { const text = await res.text(); return JSON.stringify({ ok: res.ok, status: res.status, statusText: res.statusText, raw: text }); }))()`;

    const evalOutput = execFileSync('agent-browser', ['eval', script], {
      encoding: 'utf8',
      timeout: timeoutMs
    }).trim();

    const cleaned = evalOutput
      .replace(/^['\"]/, '')
      .replace(/['\"]$/, '')
      .replace(/\\\"/g, '"');

    const parsed = JSON.parse(cleaned);

    let data;
    try {
      data = JSON.parse(parsed.raw);
    } catch (error) {
      data = { raw: parsed.raw };
    }

    return {
      ok: !!parsed.ok,
      status: parsed.status,
      statusText: parsed.statusText,
      url: requestUrl,
      data,
      mode: 'agent-browser'
    };
  } finally {
    try {
      execFileSync('agent-browser', ['close'], { stdio: 'pipe', timeout: 5000 });
    } catch (error) {
      // Ignore close failures.
    }
  }
}

async function sendMpCollectBatch(runtimeOptions = {}) {
  const options = resolveMpRequestOptions(runtimeOptions);

  const rawHeaders = options.rawHeaders || '';
  const parsedHeaders = parseRawHeaderPairs(rawHeaders);
  const requestUrl = options.url || buildUrlFromPseudoHeaders(parsedHeaders, DEFAULT_MP_URL);
  const requestBody = options.body || {};
  const requestHeaders = toRequestHeaders(parsedHeaders, options.rawCookie);

  if (!requestHeaders.cookie) {
    throw new Error('缺少 Cookie。请在 mpRequest.rawCookie 或 rawHeaders 的 cookie 中配置。');
  }

  if (!requestHeaders['content-type']) {
    requestHeaders['content-type'] = 'application/json';
  }

  if (!requestHeaders.accept) {
    requestHeaders.accept = '*/*';
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;

  if (options.mode === 'http') {
    return sendViaHttp(requestUrl, requestHeaders, requestBody, timeoutMs);
  }

  try {
    return await sendViaAgentBrowser(requestUrl, requestHeaders, requestBody, options);
  } catch (error) {
    if (!options.fallbackToHttp) {
      throw error;
    }
    return sendViaHttp(requestUrl, requestHeaders, requestBody, timeoutMs);
  }
}

function parseAgentEvalOutput(rawOutput) {
  const trimmed = (rawOutput || '').trim();
  if (!trimmed) {
    throw new Error('agent-browser eval 无返回内容');
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // Continue to attempt decoding quoted JSON strings.
  }

  const unquoted = trimmed
    .replace(/^['\"]/, '')
    .replace(/['\"]$/, '')
    .replace(/\\\"/g, '"')
    .replace(/\\n/g, '\n');

  try {
    return JSON.parse(unquoted);
  } catch (error) {
    throw new Error(`无法解析 agent-browser eval 输出: ${trimmed.slice(0, 300)}`);
  }
}

function setAgentBrowserCookies(cookiePairs) {
  cookiePairs.forEach(({ name, value }) => {
    execFileSync('agent-browser', ['cookies', 'set', name, value], {
      stdio: 'pipe',
      timeout: 5000
    });
  });
}

async function saveDraftArticleViaAgentBrowser(runtimeOptions = {}) {
  const options = resolveMpRequestOptions(runtimeOptions);
  const draftOptions = {
    openUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    waitMs: 6000,
    afterClickWaitMs: 2500,
    ...options,
    ...runtimeOptions
  };

  const title = (draftOptions.title || '').trim();
  const content = (draftOptions.content || '').trim();

  if (!title) {
    throw new Error('缺少标题 title');
  }
  if (!content) {
    throw new Error('缺少正文 content');
  }

  const parsedHeaders = parseRawHeaderPairs(draftOptions.rawHeaders || '');
  const requestHeaders = toRequestHeaders(parsedHeaders, draftOptions.rawCookie);
  const cookiePairs = parseCookieString(requestHeaders.cookie || '');

  if (cookiePairs.length === 0) {
    throw new Error('缺少 Cookie。请在 rawCookie 或 rawHeaders 中提供 cookie。');
  }

  const waitMs = Number(draftOptions.waitMs) > 0 ? Number(draftOptions.waitMs) : 6000;
  const afterClickWaitMs = Number(draftOptions.afterClickWaitMs) > 0 ? Number(draftOptions.afterClickWaitMs) : 2500;

  const script = `(() => {
    const titleText = ${JSON.stringify(title)};
    const contentText = ${JSON.stringify(content)};
    const afterClickWaitMs = ${afterClickWaitMs};

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const setInputValue = (el, value) => {
      if (!el) return false;
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const setEditorValue = (el, value) => {
      if (!el) return false;
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        return setInputValue(el, value);
      }
      el.innerHTML = '';
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const getSearchRoots = () => {
      const roots = [document];
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const frame of iframes) {
        try {
          if (frame.contentDocument) {
            roots.push(frame.contentDocument);
          }
        } catch (error) {
          // Ignore cross-origin iframe.
        }
      }
      return roots;
    };

    const findBySelectors = (selectors) => {
      const roots = getSearchRoots();
      for (const root of roots) {
        for (const selector of selectors) {
          const found = root.querySelector(selector);
          if (found) return found;
        }
      }
      return null;
    };

    const clickSaveButton = () => {
      const roots = getSearchRoots();
      const candidates = [];

      for (const root of roots) {
        candidates.push(...Array.from(root.querySelectorAll('button, [role="button"], .arco-btn, span, div')));
      }

      let fallbackSaveButton = null;

      for (const el of candidates) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;

        if (/保存草稿|存草稿|草稿箱/.test(text)) {
          el.click();
          return text;
        }

        if (/保存/.test(text) && !/发布|提交|发送/.test(text) && !fallbackSaveButton) {
          fallbackSaveButton = el;
        }
      }

      if (fallbackSaveButton) {
        const text = (fallbackSaveButton.innerText || fallbackSaveButton.textContent || '').trim();
        fallbackSaveButton.click();
        return text;
      }

      return null;
    };

    return (async () => {
      const titleEl = findBySelectors([
        'input[placeholder*="标题"]',
        'input[placeholder*="请输入标题"]',
        'input[maxlength]',
        '.title-input input',
        'textarea[placeholder*="标题"]'
      ]);

      const contentEl = findBySelectors([
        '.ProseMirror',
        '.ql-editor',
        '[data-slate-editor="true"]',
        '[contenteditable="true"]',
        '.public-DraftEditor-content',
        '.editor [contenteditable="true"]',
        'textarea[placeholder*="正文"]',
        'textarea[placeholder*="内容"]'
      ]);

      const titleSet = setInputValue(titleEl, titleText);
      const contentSet = setEditorValue(contentEl, contentText);
      const clickedButtonText = clickSaveButton();

      await sleep(afterClickWaitMs);

      return {
        ok: !!clickedButtonText,
        titleSet,
        contentSet,
        clickedButtonText,
        message: clickedButtonText ? '已触发保存草稿' : '未找到保存草稿按钮'
      };
    })();
  })()`;

  try {
    execFileSync('agent-browser', ['open', draftOptions.openUrl], {
      stdio: 'pipe',
      timeout: Math.max(waitMs + 5000, 15000)
    });

    setAgentBrowserCookies(cookiePairs);

    await new Promise(resolve => setTimeout(resolve, waitMs));

    const evalOutput = execFileSync('agent-browser', ['eval', script], {
      encoding: 'utf8',
      timeout: 30000
    });

    const result = parseAgentEvalOutput(evalOutput);

    return {
      success: !!result.ok,
      mode: 'agent-browser',
      openUrl: draftOptions.openUrl,
      title,
      result
    };
  } finally {
    try {
      execFileSync('agent-browser', ['close'], { stdio: 'pipe', timeout: 5000 });
    } catch (error) {
      // Ignore close failures.
    }
  }
}

module.exports = {
  parseRawHeaderPairs,
  sendMpCollectBatch,
  saveDraftArticleViaAgentBrowser,
  publishDraftViaHttp,
  publishWeitoutiaoViaHttp
};
