import OpenAI from "openai";

export async function POST(request: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing OpenAI API key." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Malformed JSON in request body." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { diffItem } = body as {
      diffItem?: { description: string; diff: string };
    };
    if (!diffItem || !diffItem.description || !diffItem.diff) {
      return new Response(
        JSON.stringify({
          error: "diffItem with description and diff is required.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const systemPrompt =
      "You are a helpful assistant. For each software-change description you receive, return exactly two plain-text lines—first a “Developer:” line containing one or two concise, technical sentences that state what changed and why (referencing code entities exactly as given, with no marketing tone or exclamation marks), and second a “Marketing:” line containing one clear, user-centric sentence that highlights the benefit of the same change in simple language with at most one exclamation mark. Both sentences must describe the same change consistently, be strictly grounded in the facts provided, and never invent features, components, or outcomes. When essential details are missing, output “Developer: Details insufficient to generate a developer note.” and “Marketing: Details insufficient to generate a marketing note.”; do not guess, hallucinate, or ask follow-up questions. Refuse only if the request violates explicit policies. Keep the combined length of the two lines within 60 tokens and add no extra text or formatting beyond the two required lines.";

    const userPrompt = `The description of the pull request is ${diffItem.description} and the content of the diff is ${diffItem.diff}. The response format should be a JSON object as follows: {\n  \"developer_notes\": \"string\",\n  \"marketing_notes\": \"string\"\n}`;

    const completionStream = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "set_release_notes",
            description:
              "Return developer and marketing release notes for the provided diff.",
            parameters: {
              type: "object",
              properties: {
                developer_notes: {
                  type: "string",
                  description:
                    "Concise, technical summary of what changed and why (1-2 sentences).",
                },
                marketing_notes: {
                  type: "string",
                  description:
                    "User-facing description of the benefit of the change (1-2 sentences).",
                },
              },
              required: ["developer_notes", "marketing_notes"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "set_release_notes" },
      },
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of completionStream) {
            const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
              const argsPiece = toolCalls[0]?.function?.arguments || "";
              controller.enqueue(encoder.encode(argsPiece));
            }
          }
        } catch (streamErr) {
          controller.error(streamErr);
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    const message = (err as Error).message || "Unexpected server error.";
    console.error("AI route error:", message);
    return new Response(
      JSON.stringify({
        error: "Failed to generate release notes.",
        details: message,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
