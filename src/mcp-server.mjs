import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.TOUTIAO_API_BASE || 'http://127.0.0.1:3000';
const LOGIN_USER = process.env.TOUTIAO_MCP_USERNAME || '';
const LOGIN_PASS = process.env.TOUTIAO_MCP_PASSWORD || '';
const STATIC_COOKIE = process.env.TOUTIAO_MCP_COOKIE || '';

let sessionCookie = STATIC_COOKIE;

function joinUrl(path) {
  return `${API_BASE.replace(/\/$/, '')}${path}`;
}

function extractSetCookieHeader(response) {
  const headers = response.headers;
  if (!headers) return '';

  if (typeof headers.getSetCookie === 'function') {
    const raw = headers.getSetCookie();
    if (Array.isArray(raw) && raw.length) {
      return raw.map((line) => line.split(';')[0]).join('; ');
    }
  }

  const single = headers.get('set-cookie');
  if (!single) return '';
  return single.split(',').map((line) => line.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function ensureLogin() {
  if (sessionCookie || !LOGIN_USER || !LOGIN_PASS) {
    return;
  }

  const response = await fetch(joinUrl('/api/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASS })
  });

  const nextCookie = extractSetCookieHeader(response);
  if (nextCookie) {
    sessionCookie = nextCookie;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Login failed: ${response.status} ${text.slice(0, 200)}`);
  }
}

async function apiRequest(path, options = {}) {
  await ensureLogin();

  const headers = {
    ...(options.headers || {})
  };

  if (sessionCookie) {
    headers.cookie = sessionCookie;
  }

  const response = await fetch(joinUrl(path), {
    ...options,
    headers
  });

  const setCookie = extractSetCookieHeader(response);
  if (setCookie) {
    sessionCookie = setCookie;
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const message = json && json.message ? json.message : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

function textResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

const tools = [
  {
    name: 'get_hotspots',
    description: 'Get latest hotspot list from /api/hotspots',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'get_new_hotspots',
    description: 'Get new hotspot entries from /api/new, optional category',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'refresh_hotspots',
    description: 'Trigger hotspot refresh via /api/hotspots/refresh',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'list_publish_queue',
    description: 'List pending/reviewed/hold/published articles from /api/publish-queue',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        status: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'create_pending_article',
    description: 'Create a pending article for review in /api/publish-queue',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        coverUrl: { type: 'string' },
        sourceUrl: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string' }
      },
      required: ['title', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'update_pending_article',
    description: 'Update an existing queue article by id',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        content: { type: 'string' },
        coverUrl: { type: 'string' },
        sourceUrl: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'publish_pending_article_http',
    description: 'Publish queue article by id using /api/publish-queue/:id/publish/http',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        publishOptions: { type: 'object' }
      },
      required: ['id'],
      additionalProperties: true
    }
  },
  {
    name: 'delete_pending_article',
    description: 'Delete queue article by id',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'publish_weitoutiao_http',
    description: 'Publish 微头条 via /api/mp/weitoutiao/publish/http',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        coverImageUrl: { type: 'string' },
        sourceUrl: { type: 'string' },
        rawBody: { type: 'string' },
        rawBodyTemplate: { type: 'string' },
        rawBodyTemplatePath: { type: 'string' },
        rawHeaders: { type: 'string' },
        rawCookie: { type: 'string' },
        timeoutMs: { type: 'number' },
        enableAdvertisement: { type: 'boolean' },
        enableToutiaoFirstPublish: { type: 'boolean' }
      },
      required: ['content'],
      additionalProperties: true
    }
  },
  {
    name: 'publish_mp_http',
    description: 'Generic publish via /api/mp/publish/http, supports publishType=article|weitoutiao',
    inputSchema: {
      type: 'object',
      properties: {
        publishType: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        coverImageUrl: { type: 'string' },
        sourceUrl: { type: 'string' },
        rawBody: { type: 'string' },
        rawBodyTemplate: { type: 'string' },
        rawBodyTemplatePath: { type: 'string' },
        rawHeaders: { type: 'string' },
        rawCookie: { type: 'string' },
        timeoutMs: { type: 'number' },
        enableAdvertisement: { type: 'boolean' },
        enableToutiaoFirstPublish: { type: 'boolean' }
      },
      required: ['content'],
      additionalProperties: true
    }
  }
];

const server = new Server(
  {
    name: 'toutiao-hot-monitor-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};

  try {
    if (name === 'get_hotspots') {
      const result = await apiRequest('/api/hotspots');
      return textResult(result);
    }

    if (name === 'get_new_hotspots') {
      const qs = args.category ? `?category=${encodeURIComponent(String(args.category))}` : '';
      const result = await apiRequest(`/api/new${qs}`);
      return textResult(result);
    }

    if (name === 'refresh_hotspots') {
      const result = await apiRequest('/api/hotspots/refresh', {
        method: 'POST'
      });
      return textResult(result);
    }

    if (name === 'list_publish_queue') {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.status) params.set('status', String(args.status));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await apiRequest(`/api/publish-queue${qs}`);
      return textResult(result);
    }

    if (name === 'create_pending_article') {
      const result = await apiRequest('/api/publish-queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args)
      });
      return textResult(result);
    }

    if (name === 'update_pending_article') {
      const { id, ...rest } = args;
      const result = await apiRequest(`/api/publish-queue/${Number(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rest)
      });
      return textResult(result);
    }

    if (name === 'publish_pending_article_http') {
      const id = Number(args.id);
      const result = await apiRequest(`/api/publish-queue/${id}/publish/http`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args.publishOptions || {})
      });
      return textResult(result);
    }

    if (name === 'delete_pending_article') {
      const result = await apiRequest(`/api/publish-queue/${Number(args.id)}`, {
        method: 'DELETE'
      });
      return textResult(result);
    }

    if (name === 'publish_weitoutiao_http') {
      const payload = {
        enableAdvertisement: true,
        enableToutiaoFirstPublish: true,
        ...args
      };

      const result = await apiRequest('/api/mp/weitoutiao/publish/http', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return textResult(result);
    }

    if (name === 'publish_mp_http') {
      const payload = {
        enableAdvertisement: true,
        enableToutiaoFirstPublish: true,
        ...args
      };

      const result = await apiRequest('/api/mp/publish/http', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return textResult(result);
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'toutiao://config',
        name: 'MCP Config',
        description: 'Current MCP runtime config for Toutiao server',
        mimeType: 'application/json'
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params?.uri !== 'toutiao://config') {
    throw new Error(`Unsupported resource: ${request.params?.uri || ''}`);
  }

  return {
    contents: [
      {
        uri: 'toutiao://config',
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            apiBase: API_BASE,
            hasStaticCookie: Boolean(STATIC_COOKIE),
            hasLoginCredentials: Boolean(LOGIN_USER && LOGIN_PASS)
          },
          null,
          2
        )
      }
    ]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
