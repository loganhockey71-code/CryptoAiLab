// Vercel AI Gateway example. A plain "creator/model" string is routed through the Gateway using AI_GATEWAY_API_KEY from .env.
// Run:  node --env-file=.env index.ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: 'moonshotai/kimi-k3',
  prompt: 'Invent a new holiday and describe its traditions.',
});

console.log(text);
