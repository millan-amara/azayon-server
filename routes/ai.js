const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');

router.use(protect);

// POST /api/ai/chat - proxy to Anthropic, keeps API key server-side
router.post('/chat', async (req, res, next) => {
  try {
    const { systemPrompt, userPrompt, maxTokens = 1000, stream = false } = req.body;

    if (!systemPrompt || !userPrompt) {
      return res.status(400).json({ error: 'systemPrompt and userPrompt are required' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI features not configured. Add ANTHROPIC_API_KEY to your .env' });
    }

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: Math.min(maxTokens, 2000),
      stream,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'AI request failed' });
    }

    if (stream) {
      // Use Web Streams reader (Node 18+ fetch returns Web ReadableStream, not Node stream)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          console.error('Stream error:', err.message);
          res.end();
        }
      };

      pump();
    } else {
      const data = await response.json();
      res.json({ text: data.content?.[0]?.text || '' });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;