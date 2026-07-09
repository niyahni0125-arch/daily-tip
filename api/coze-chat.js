// api/coze-chat.js
//
// 这是一个 Vercel Serverless Function（Node.js 运行时）。
// 部署后，浏览器只会请求同源的 /api/coze-chat，
// 真正的 Coze Personal Access Token 只存在于这个文件运行的服务器环境变量里，
// 不会出现在任何前端代码、网页源码或浏览器 Network 面板中。
//
// ============ 部署前必须做的事 ============
// 1. 【重要】之前贴在聊天里的 token（pat_ba6d... 开头）已经泄露，
//    请先去 Coze 控制台（https://www.coze.cn/open/oauth/pats）撤销它，
//    重新生成一个新的 Personal Access Token，并确保勾选了 chat 权限。
// 2. 用 Vercel CLI 或 Vercel 网页后台，给你的项目添加两个环境变量：
//      COZE_TOKEN   = 你新生成的 token（千万不要写进代码里）
//      COZE_BOT_ID  = 你的 Coze 智能体 ID
//    （bot_id 可以在扣子后台编辑智能体页面的 URL 里找到，
//     形如 https://www.coze.cn/space/xxxx/bot/74xxxxxxxxxxxxxxxx，
//     /bot/ 后面那一串数字就是 bot_id）
// 3. 项目结构大致是：
//      /index.html          <- 就是你的「每日英语小贴」页面
//      /api/coze-chat.js    <- 就是这个文件
//    用 `vercel` 或 `vercel --prod` 部署即可，Vercel 会自动把 /api 目录
//    下的文件识别成 Serverless Function。
// ==========================================

const COZE_API_BASE = 'https://api.coze.cn';
const MAX_POLL_ATTEMPTS = 10; // 最多轮询 10 次
const POLL_INTERVAL_MS = 1000; // 每次间隔 1 秒（约等待 10 秒）

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '只支持 POST 请求' });
    return;
  }

  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: '缺少有效的 message 参数' });
    return;
  }

  const COZE_TOKEN = process.env.COZE_TOKEN;
  const COZE_BOT_ID = process.env.COZE_BOT_ID;

  if (!COZE_TOKEN || !COZE_BOT_ID) {
    res.status(500).json({
      error: '服务端尚未配置 COZE_TOKEN / COZE_BOT_ID 环境变量，请先在 Vercel 项目设置里添加。'
    });
    return;
  }

  const headers = {
    'Authorization': `Bearer ${COZE_TOKEN}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1) 发起对话
    const chatResp = await fetch(`${COZE_API_BASE}/v3/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bot_id: COZE_BOT_ID,
        user_id: 'daily-tip-demo-user',
        stream: false,
        auto_save_history: true,
        additional_messages: [
          { role: 'user', content: message, content_type: 'text' }
        ]
      })
    });
    const chatData = await chatResp.json();

    if (!chatResp.ok || chatData.code !== 0 || !chatData.data) {
      res.status(502).json({ error: 'Coze 发起对话失败', detail: chatData });
      return;
    }

    const conversationId = chatData.data.conversation_id;
    const chatId = chatData.data.id;
    let status = chatData.data.status;

    // 2) 轮询直到对话完成（或超时 / 失败）
    let attempts = 0;
    while (status !== 'completed' && attempts < MAX_POLL_ATTEMPTS) {
      await sleep(POLL_INTERVAL_MS);
      const retrieveResp = await fetch(
        `${COZE_API_BASE}/v3/chat/retrieve?conversation_id=${conversationId}&chat_id=${chatId}`,
        { headers }
      );
      const retrieveData = await retrieveResp.json();
      status = retrieveData && retrieveData.data && retrieveData.data.status;
      attempts += 1;

      if (status === 'failed') {
        res.status(502).json({ error: 'Agent 处理失败', detail: retrieveData });
        return;
      }
    }

    if (status !== 'completed') {
      res.status(504).json({ error: 'Agent 响应超时，请稍后重试' });
      return;
    }

    // 3) 拉取消息列表，取出 assistant 的 answer 类型内容
    const listResp = await fetch(
      `${COZE_API_BASE}/v3/chat/message/list?conversation_id=${conversationId}&chat_id=${chatId}`,
      { headers }
    );
    const listData = await listResp.json();

    const answer = ((listData && listData.data) || [])
      .filter((m) => m.role === 'assistant' && m.type === 'answer')
      .map((m) => m.content)
      .join('\n')
      .trim();

    res.status(200).json({ reply: answer || '（Agent 没有返回文本内容）' });
  } catch (err) {
    res.status(500).json({ error: '服务器请求 Coze 时出错', detail: String(err) });
  }
};
