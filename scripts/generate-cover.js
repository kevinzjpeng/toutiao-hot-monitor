#!/usr/bin/env node
/**
 * 使用 Qwen 文生图 API 生成文章封面图
 */

const https = require('https');
const config = require('../config.json');

const API_KEY = config.featuredImageGeneration.apiKey;
const ENDPOINT = config.featuredImageGeneration.endpoint;
const MODEL = config.featuredImageGeneration.model;
const SIZE = config.featuredImageGeneration.size;
const PROMPT_TEMPLATE = config.featuredImageGeneration.promptTemplate;

function callQwenImageAPI(prompt) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: MODEL,
      input: {
        prompt: prompt
      },
      parameters: {
        size: SIZE,
        n: 1
      }
    });

    const options = {
      hostname: 'dashscope.aliyuncs.com',
      port: 443,
      path: '/api/v1/services/aigc/text2image/image-synthesis',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'X-DashScope-Async': 'enable'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`解析失败：${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getTaskResult(taskId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'dashscope.aliyuncs.com',
      port: 443,
      path: `/api/v1/tasks/${taskId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`解析失败：${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function generateCover(title, keywords = '') {
  console.log('🎨 开始生成封面图...\n');
  console.log('📝 文章标题:', title);
  console.log('🏷️ 关键词:', keywords);
  console.log();

  // 构建提示词
  const prompt = PROMPT_TEMPLATE.replace('{{title}}', title) + 
    (keywords ? ` 关键元素：${keywords}` : '');
  
  console.log('💬 提示词:', prompt);
  console.log();

  // 调用 API
  console.log('📡 调用 Qwen 文生图 API...');
  const submitResult = await callQwenImageAPI(prompt);
  
  if (submitResult.code || submitResult.error) {
    throw new Error(`API 提交失败：${JSON.stringify(submitResult)}`);
  }

  const taskId = submitResult.output?.task_id;
  if (!taskId) {
    throw new Error(`未获取到 task_id: ${JSON.stringify(submitResult)}`);
  }

  console.log('✅ 任务提交成功，Task ID:', taskId);
  console.log();

  // 轮询任务状态
  console.log('⏳ 等待图片生成...');
  let maxAttempts = 30;
  let attempt = 0;
  let imageUrl = null;

  while (attempt < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    attempt++;

    const taskResult = await getTaskResult(taskId);
    const taskStatus = taskResult.output?.task_status;

    console.log(`   第 ${attempt} 次查询 - 状态：${taskStatus}`);

    if (taskStatus === 'SUCCEEDED') {
      imageUrl = taskResult.output?.results?.[0]?.url;
      if (imageUrl) {
        console.log('✅ 图片生成成功!');
        break;
      }
    } else if (taskStatus === 'FAILED') {
      throw new Error(`图片生成失败：${JSON.stringify(taskResult)}`);
    }

    if (attempt >= maxAttempts) {
      throw new Error('等待超时，图片生成未完成');
    }
  }

  if (!imageUrl) {
    throw new Error('未能获取图片 URL');
  }

  console.log();
  console.log('🖼️ 封面图 URL:', imageUrl);
  console.log();

  return {
    success: true,
    imageUrl,
    taskId,
    prompt
  };
}

// 主程序
async function main() {
  const article = {
    title: '男孩把干冰放冰箱发生爆炸！这些居家安全隐患家长一定要知道',
    keywords: '干冰，爆炸，居家安全，儿童安全，冰箱，安全教育，警示'
  };

  try {
    const result = await generateCover(article.title, article.keywords);
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ 封面图生成完成');
    console.log('═══════════════════════════════════════════════════════');
    console.log('图片 URL:', result.imageUrl);
    console.log('Task ID:', result.taskId);
    console.log('═══════════════════════════════════════════════════════\n');

    // 输出 JSON 供脚本调用
    console.log('JSON_OUTPUT:', JSON.stringify(result));
  } catch (error) {
    console.error('❌ 封面图生成失败:', error.message);
    process.exit(1);
  }
}

main();
