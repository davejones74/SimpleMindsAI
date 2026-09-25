/**
 * OllamaClient — the ONLY place that talks to Ollama's HTTP API.
 *
 * Every subsystem (curator, critic, planner, brain) goes through this one file,
 * which is what makes `OLLAMA_FIXTURE=true` able to stub the entire pipeline:
 * you can smoke-test the full loop before burning a single VRAM byte.
 *
 * deepseek-r1 caveat baked in: r1 is a *reasoning* model. When wrapped behind
 * Ollama it can leak its chain-of-thought into the final answer, and for the
 * RLHF-style distills the CoT lives in `message.reasoning`. We strip both, and
 * we pin the model tag to whatever `ollama list` shows (default `:latest`,
 * which on consumer rigs is a 4-7GB distill, NOT the 671B MoE).
 */

export class OllamaClient {
  constructor(opts = {}) {
    this.endpoint = opts.endpoint ?? process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? "deepseek-r1:latest";
    this.fixture = opts.fixture ?? process.env.OLLAMA_FIXTURE === "true";
    this.defaultOptions = {
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.95,
      // NOTE: no num_predict here on purpose. deepseek-r1:latest counts its
      // hidden chain-of-thought tokens against num_predict; a tight cap burns
      // the whole budget on reasoning and returns an EMPTY final answer (seen
      // live during bring-up: num_predict=2048 -> content length 0, eval=2048).
      // Only set it when a caller explicitly passes maxTokens.
    };
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async #request(path, body, stream = false) {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama ${path} ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!stream) return res.json();
    return res;
  }

  /** Non-streaming chat. Returns final text with any CoT stripped. */
  async chat({ messages, format, temperature, maxTokens }) {
    if (this.fixture) return { text: this.#fixtureReply(messages) };
    const options = { ...this.defaultOptions, temperature: temperature ?? this.defaultOptions.temperature };
    if (maxTokens) options.num_predict = maxTokens;
    const body = await this.#request("/api/chat", {
      model: this.model,
      messages,
      stream: false,
      ...(format ? { format } : {}),
      options,
    });
    return {
      text: this.#stripReasoning(body.message?.content ?? ""),
      reasoning: body.message?.reasoning ?? null,
      promptEvalCount: body.prompt_eval_count ?? null,
      evalCount: body.eval_count ?? null,
    };
  }

  /**
   * Streaming chat as an async generator — yields { token, done }.
   * The generator contract lets callers implement real backpressure: reading
   * the next token is bounded by `reader.read()`, so a slow consumer naturally
   * backpressures TCP without buffering the whole model response in RAM.
   */
  async *streamChat({ messages, temperature = 0.7 }) {
    if (this.fixture) {
      yield { token: " [fixture stream] ", done: false };
      yield { token: "> ", done: false };
      yield { token: this.#fixtureReply(messages), done: true };
      return;
    }
    const res = await this.#request(
      "/api/chat",
      { model: this.model, messages, stream: true, options: { ...this.defaultOptions, temperature } },
      true
    );
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        yield { token: "", done: true };
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let part;
        try {
          part = JSON.parse(line);
        } catch {
          continue;
        }
        yield { token: this.#stripReasoning(part.message?.content ?? ""), done: part.done ?? false, reasoning: part.message?.reasoning ?? null };
        if (part.done) return;
      }
    }
  }

  /** Shorthand for the "clean raw text into prompt/completion pairs" job. */
  async clean(rawText, { maxTokens = 4096 } = {}) {
    const { text } = await this.chat({
      format: "json",
      temperature: 0.2, // cleaning should be deterministic, not creative
      maxTokens,
      messages: [
        {
          role: "system",
          content: [
            "You are a text curation pipeline stage.",
            "Clean, filter and structure the user's raw scraped text into JSON.",
            "Rules:",
            "  - Return ONLY a JSON array of objects: [{ \"prompt\": string, \"completion\": string, \"domain\": string }]",
            "  - Drop boilerplate, nav menus, ads, markup, and anything unsafe/PII.",
            "  - If the text is unusable (junk/garbage), return [].",
            "  - prompt = a crisp instruction/question the text answers; completion = the factual answer, max 200 words.",
            "  - domain = one of: science, tech, history, general, fiction, howto.",
          ].join("\n"),
        },
        { role: "user", content: rawText.slice(0, 14_000) },
      ],
    });
    return this.#parsePairs(text);
  }

  #parsePairs(text) {
    // deepseek-r1 is loose with JSON "spec": sometimes a plain array, sometimes
    // a single object, sometimes wrapped { "results": [...] }. Normalize all.
    const same = (t) => t && typeof t === "object" && typeof t.prompt === "string" && typeof t.completion === "string";
    const trimmed = String(text).trim();
    const raw = trimmed.startsWith("[") ? trimmed : trimmed;
    const firstArr = raw.indexOf("[");
    const lastArr = raw.lastIndexOf("]");
    if (firstArr !== -1 && lastArr > firstArr) {
      try {
        const arr = JSON.parse(raw.slice(firstArr, lastArr + 1));
        if (Array.isArray(arr)) {
          const out = arr.filter(same);
          if (out.length) return out;
        }
      } catch {
        /* fall through to object form */
      }
    }
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return [];
    let root;
    try {
      root = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      return [];
    }
    let arr = Array.isArray(root) ? root : root && Array.isArray(root.results) ? root.results : Array.isArray(root.pairs) ? root.pairs : [root];
    return arr.filter(same);
  }

  #stripReasoning(content) {
    let s = String(content ?? "");
    s = s.replace(/<[\s\S]*?think[\s\S]*?>/gi, "");
    s = s.replace(/<\/?think>/gi, "");
    return s.trim();
  }

  #fixtureReply(messages) {
    const user = [...messages].reverse().find((m) => m.role === "user");
    const raw = String(user?.content ?? "");
    const isCurator =
      messages.some((m) => m.role === "system" && /curation pipeline/i.test(m.content ?? "")) ||
      messages.some((m) => m.role === "system" && /reward model/i.test(m.content ?? ""));

    // Curator fixture: echo one sanitized prompt/completion pair per raw block.
    if (isCurator && /reward model/i.test(messages.find((m) => m.role === "system")?.content ?? "")) {
      return JSON.stringify({ score: 6.5, rationale: "fixture critic: plausible, low repetition" });
    }
    if (isCurator) {
      const first = raw.split("\n").find((l) => l.trim() && !l.trim().startsWith("||"));
      const completion = (first ?? raw).replace(/[|]+/g, "").trim().slice(0, 160);
      return JSON.stringify([
        { prompt: "Summarize the following text: " + completion.slice(0, 60), completion, domain: completion.length ? "general" : "junk" },
        { prompt: "Fact-check: " + completion.slice(0, 60), completion: "Fixture answer: insufficient evidence in source.", domain: "factcheck" },
      ]);
    }
    return `{ "fixture": true, "echo": ${JSON.stringify(raw.slice(0, 120))} }`;
  }
}