import { Handler } from "@netlify/functions";
import { GoogleGenAI } from "@google/genai";

const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { 
      statusCode: 503, 
      body: JSON.stringify({ error: "GEMINI_API_KEY is not configured on Netlify." }) 
    };
  }

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body || "{}");

    if (!imageBase64 || !mimeType) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: "Missing imageBase64 or mimeType" }) 
      };
    }

    const genAI = new GoogleGenAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = "Extract receipt items and prices. Return a JSON array of objects. Format: [{ name: 'item name', price: 1000 }]. No markdown, just JSON.";

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: imageBase64,
          mimeType: mimeType
        }
      }
    ]);

    const response = await result.response;
    let text = response.text();
    
    // Clean up markdown if AI returned it
    if (text.startsWith("```json")) {
      text = text.replace(/```json\n?/, "").replace(/\n?```/, "");
    } else if (text.startsWith("```")) {
       text = text.replace(/```\n?/, "").replace(/\n?```/, "");
    }

    // Double check it's valid JSON
    JSON.parse(text);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: text
    };
  } catch (err) {
    console.error("AI scanning error:", err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Failed to scan receipt via AI." }) 
    };
  }
};

export { handler };
