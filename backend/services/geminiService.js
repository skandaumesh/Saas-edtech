const Groq = require('groq-sdk');
require('dotenv').config();

class AIService {
  constructor() {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });

    // Using llama-3.3-70b-versatile - current working model
    this.model = "llama-3.3-70b-versatile";
    this.maxRetries = 3;
    this.retryDelay = 2000;
  }

  async generateResponse(prompt) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🤖 Calling Groq Llama API (attempt ${attempt})...`);

        const completion = await this.groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content: "You are a helpful college AI assistant that helps with student information, attendance, and academic queries. Be concise and helpful."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          model: this.model,
          temperature: 0.2,
          max_tokens: 2048,
        });

        console.log('✅ Groq API response received');
        return completion.choices[0]?.message?.content || "No response generated";
      } catch (error) {
        lastError = error;
        console.error(`❌ Groq API Error (attempt ${attempt}):`, error.message);

        if (error.status === 503 || error.status === 429 || error.message?.includes('rate')) {
          console.log(`⚠️ Rate limited, retrying...`);
          await this.sleep(this.retryDelay * attempt);
          continue;
        }
        throw new Error('AI Error: ' + error.message);
      }
    }
    throw new Error('AI API unavailable after retries');
  }

  // Generate response WITH conversation history (like ChatGPT)
  async generateResponseWithHistory(prompt, conversationHistory = []) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🤖 Calling Groq Llama API with ${conversationHistory.length} history messages (attempt ${attempt})...`);

        // Build messages array with conversation history
        const messages = [
          {
            role: "system",
            content: `You are a helpful college AI assistant for MLA Academy of Higher Learning. You help with student information, attendance, subjects, and academic queries.

IMPORTANT RULES:
- When the user asks a follow-up question (like "what about X?" or "and for Y?"), understand the context from previous messages
- If the previous question was about attendance and the user says "what about Skanda?", they want Skanda's attendance too
- If the previous question was about a student list and user says "how many?", they want the count
- Always maintain context from the conversation
- Be concise, accurate, and helpful
- Format responses using Markdown (tables, headers, bold, lists)
- DO NOT use emojis`
          }
        ];

        // Add conversation history (limit to last 10 exchanges to stay within token limits)
        const recentHistory = conversationHistory.slice(-20);
        for (const msg of recentHistory) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          });
        }

        // Add the current prompt
        messages.push({
          role: "user",
          content: prompt
        });

        const completion = await this.groq.chat.completions.create({
          messages,
          model: this.model,
          temperature: 0.2,
          max_tokens: 2048,
        });

        console.log('✅ Groq API response received (with history)');
        return completion.choices[0]?.message?.content || "No response generated";
      } catch (error) {
        lastError = error;
        console.error(`❌ Groq API Error (attempt ${attempt}):`, error.message);

        if (error.status === 503 || error.status === 429 || error.message?.includes('rate')) {
          console.log(`⚠️ Rate limited, retrying...`);
          await this.sleep(this.retryDelay * attempt);
          continue;
        }
        throw new Error('AI Error: ' + error.message);
      }
    }
    throw new Error('AI API unavailable after retries');
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new AIService();
