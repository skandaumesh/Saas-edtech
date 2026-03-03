const Groq = require('groq-sdk');
require('dotenv').config();

class AIService {
  constructor() {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });

    // Using llama-3.3-70b-versatile - better instruction following, less hallucination
    this.model = "llama-3.3-70b-versatile";
    // Fallback model if 70b fails (rate limits)
    this.fallbackModel = "llama-3.1-8b-instant";
    this.maxRetries = 3;
    this.retryDelay = 2000;
  }

  async generateResponse(prompt) {
    let lastError;
    let currentModel = this.model;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🤖 Calling Groq API [${currentModel}] (attempt ${attempt})...`);

        const completion = await this.groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `You are a precise database query assistant. Your ONLY job is to convert questions into MongoDB queries or format database results.

ABSOLUTE RULES:
- NEVER invent, fabricate, or guess any data
- ONLY use information explicitly provided to you
- If data is missing, say "not found" - NEVER make up values
- Be concise and accurate`
            },
            {
              role: "user",
              content: prompt
            }
          ],
          model: currentModel,
          temperature: 0.1,
          max_tokens: 2048,
        });

        console.log('✅ Groq API response received');
        return completion.choices[0]?.message?.content || "No response generated";
      } catch (error) {
        lastError = error;
        console.error(`❌ Groq API Error (attempt ${attempt}):`, error.message);

        // If 70b model fails with rate limit, switch to fallback
        if ((error.status === 429 || error.message?.includes('rate')) && currentModel === this.model) {
          console.log(`⚠️ Rate limited on ${currentModel}, switching to fallback ${this.fallbackModel}...`);
          currentModel = this.fallbackModel;
          await this.sleep(this.retryDelay);
          continue;
        }

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
    let currentModel = this.model;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🤖 Calling Groq API [${currentModel}] with ${conversationHistory.length} history (attempt ${attempt})...`);

        // Build messages array with conversation history
        const messages = [
          {
            role: "system",
            content: `You are an academic AI assistant for MLA Academy of Higher Learning. You help with student information, attendance, subjects, and academic queries.

CRITICAL ACCURACY RULES (NEVER BREAK):
1. ONLY use data EXPLICITLY provided in the current message. NEVER invent or guess data.
2. If asked about a specific person and their data is NOT in the results, say "I don't have data for [name]" - NEVER substitute another person's data.
3. NEVER fabricate names, IDs, percentages, or any statistics.
4. If the database returned 0 results, say "No records found" - do NOT make up results.
5. When showing data, use EXACT values from the database - never round, change, or estimate.

FORMATTING:
- Use Markdown tables, headers, bold, and lists
- Be concise and accurate
- DO NOT use emojis
- Maintain context from conversation history for follow-up questions`
          }
        ];

        // Add conversation history (limit to last 6 exchanges)
        const recentHistory = conversationHistory.slice(-6);
        for (const msg of recentHistory) {
          let safeContent = msg.content;
          if (safeContent && safeContent.length > 1500) {
            safeContent = safeContent.substring(0, 1500) + "\n...[truncated]...";
          }
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: safeContent
          });
        }

        // Add the current prompt
        messages.push({
          role: "user",
          content: prompt
        });

        const completion = await this.groq.chat.completions.create({
          messages,
          model: currentModel,
          temperature: 0.1,
          max_tokens: 2048,
        });

        console.log('✅ Groq API response received (with history)');
        return completion.choices[0]?.message?.content || "No response generated";
      } catch (error) {
        lastError = error;
        console.error(`❌ Groq API Error (attempt ${attempt}):`, error.message);

        // If 70b model fails with rate limit, switch to fallback
        if ((error.status === 429 || error.message?.includes('rate')) && currentModel === this.model) {
          console.log(`⚠️ Rate limited on ${currentModel}, switching to fallback ${this.fallbackModel}...`);
          currentModel = this.fallbackModel;
          await this.sleep(this.retryDelay);
          continue;
        }

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
